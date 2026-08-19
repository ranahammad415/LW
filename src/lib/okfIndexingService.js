/**
 * Keeps the OkfAssetIndex table in sync with the markdown files on disk, and
 * maintains project strategy revision history.
 */
import { prisma } from './prisma.js';
import { listClientFiles, writeOkfFile } from './knowledgeEngine.js';

// updated_at comes from a hand-editable YAML header, so it can be anything.
function safeDate(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * Scans a client's knowledge base directory, parses metadata headers, and
 * synchronizes OkfAssetIndex (create / update / prune).
 */
export async function reindexOkfAssets(clientId) {
  try {
    const diskFiles = listClientFiles(clientId);

    const indexedAssets = await prisma.okfAssetIndex.findMany({ where: { clientId } });
    const indexedMap = new Map(indexedAssets.map((item) => [item.relPath, item]));
    const diskPaths = new Set(diskFiles.map((f) => f.rel_path));

    let createdCount = 0;
    let updatedCount = 0;
    const deletedPaths = [];

    for (const diskFile of diskFiles) {
      const existing = indexedMap.get(diskFile.rel_path);
      const lastModified = safeDate(diskFile.updated_at);

      if (!existing) {
        await prisma.okfAssetIndex.create({
          data: {
            clientId,
            filename: diskFile.filename,
            folder: diskFile.folder,
            relPath: diskFile.rel_path,
            title: String(diskFile.title || diskFile.filename).slice(0, 255),
            type: String(diskFile.type || 'unknown').slice(0, 100),
            sizeBytes: diskFile.size_bytes,
            lastModified,
          },
        });
        createdCount++;
        continue;
      }

      const diskModified = lastModified.getTime();
      const dbModified = new Date(existing.lastModified).getTime();

      if (existing.sizeBytes !== diskFile.size_bytes || Math.abs(dbModified - diskModified) > 1000) {
        await prisma.okfAssetIndex.update({
          where: { id: existing.id },
          data: {
            title: String(diskFile.title || diskFile.filename).slice(0, 255),
            type: String(diskFile.type || 'unknown').slice(0, 100),
            sizeBytes: diskFile.size_bytes,
            lastModified,
            indexedAt: new Date(),
          },
        });
        updatedCount++;
      }
    }

    for (const asset of indexedAssets) {
      if (!diskPaths.has(asset.relPath)) {
        await prisma.okfAssetIndex.delete({ where: { id: asset.id } });
        deletedPaths.push(asset.relPath);
      }
    }

    return {
      success: true,
      createdCount,
      updatedCount,
      deletedCount: deletedPaths.length,
      deletedPaths,
    };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

export async function listOkfIndex(clientId, { folder, type, search } = {}) {
  const where = { clientId };
  if (folder) where.folder = folder;
  if (type) where.type = type;
  if (search) where.title = { contains: search };

  return prisma.okfAssetIndex.findMany({
    where,
    orderBy: [{ folder: 'asc' }, { filename: 'asc' }],
    take: 500,
  });
}

/**
 * Creates a new historical revision of a project's strategy blueprint and
 * mirrors it into the client's OKF tree.
 */
export async function logStrategyVersion(projectId, content, authorId, changeSummary) {
  try {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new Error('Project not found');

    const latest = await prisma.strategyVersion.findFirst({
      where: { projectId },
      orderBy: { versionNumber: 'desc' },
    });
    const nextVer = latest ? latest.versionNumber + 1 : 1;

    const version = await prisma.strategyVersion.create({
      data: {
        projectId,
        versionNumber: nextVer,
        content,
        authorId,
        changeSummary: (changeSummary || `Update version ${nextVer}`).slice(0, 500),
      },
    });

    writeOkfFile(project.clientId, 'seo/strategy', 'strategy', {
      title: 'Project SEO Strategy Blueprint',
      type: 'seo-strategy',
      project_id: projectId,
      version: nextVer,
    }, content);

    return { success: true, version };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

export async function listStrategyVersions(projectId) {
  return prisma.strategyVersion.findMany({
    where: { projectId },
    orderBy: { versionNumber: 'desc' },
    select: {
      id: true,
      versionNumber: true,
      authorId: true,
      changeSummary: true,
      createdAt: true,
    },
    take: 100,
  });
}

/**
 * Restores a historical strategy revision, recording the restore as a new
 * version rather than rewriting history.
 */
export async function rollbackStrategyTo(projectId, versionNumber, authorId = 'ROLLBACK_SYSTEM') {
  try {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new Error('Project not found');

    const versionRecord = await prisma.strategyVersion.findFirst({
      where: { projectId, versionNumber },
    });
    if (!versionRecord) {
      throw new Error(`Strategy version ${versionNumber} not found for this project`);
    }

    const latest = await prisma.strategyVersion.findFirst({
      where: { projectId },
      orderBy: { versionNumber: 'desc' },
    });
    const nextVer = latest ? latest.versionNumber + 1 : 1;

    writeOkfFile(project.clientId, 'seo/strategy', 'strategy', {
      title: 'Project SEO Strategy Blueprint',
      type: 'seo-strategy',
      project_id: projectId,
      version: nextVer,
      rolled_back_from: versionNumber,
    }, versionRecord.content);

    await prisma.strategyVersion.create({
      data: {
        projectId,
        versionNumber: nextVer,
        content: versionRecord.content,
        authorId,
        changeSummary: `Rolled back to version ${versionNumber}`,
      },
    });

    return { success: true, restoredContent: versionRecord.content, versionNumber: nextVer };
  } catch (err) {
    return { success: false, message: err.message };
  }
}
