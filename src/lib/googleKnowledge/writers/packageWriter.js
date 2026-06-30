/**
 * Write extraction package artifacts to disk.
 */
import fs from 'fs/promises';
import path from 'path';
import {
  LIKELY_ROLE,
  ROLE_KEYWORDS,
  FILE_KIND,
} from '../constants.js';

function kindSortOrder(kind) {
  if (kind === FILE_KIND.SPREADSHEET) return 0;
  if (kind === FILE_KIND.DOCUMENT) return 1;
  return 2;
}

function sortIndexEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    const ko = kindSortOrder(a.kind) - kindSortOrder(b.kind);
    if (ko !== 0) return ko;
    return (a.title || '').localeCompare(b.title || '');
  });
}

function buildGraph(pkg, indexEntries) {
  const edges = [];
  for (const e of indexEntries) {
    if (e.parentFileId) {
      edges.push({
        from: e.parentFileId,
        to: e.fileId,
        linkText: e.title,
      });
    }
    for (const childId of e.childFileIds || []) {
      if (!edges.some((x) => x.from === e.fileId && x.to === childId)) {
        edges.push({ from: e.fileId, to: childId, linkText: '' });
      }
    }
  }
  return {
    nodes: indexEntries.map((e) => ({
      fileId: e.fileId,
      type: e.kind,
      title: e.title,
      depth: e.depth,
      likelyRole: e.likelyRole,
    })),
    edges,
  };
}

/**
 * @param {string} title
 * @param {string} text
 * @returns {string}
 */
export function classifyLikelyRole(title = '', text = '') {
  const hay = `${title}\n${text}`.toLowerCase();
  for (const [role, keywords] of Object.entries(ROLE_KEYWORDS)) {
    if (keywords.some((kw) => hay.includes(kw))) return role;
  }
  return LIKELY_ROLE.UNKNOWN;
}

function safeFileName(name) {
  return String(name || 'untitled')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .slice(0, 120);
}

/**
 * @param {string} outDir - run output directory
 * @param {object} pkg
 */
export async function writeExtractionPackage(outDir, pkg) {
  const nodesDir = path.join(outDir, 'nodes');
  const sheetsDir = path.join(outDir, 'sheets');
  await fs.mkdir(nodesDir, { recursive: true });
  await fs.mkdir(sheetsDir, { recursive: true });

  const indexEntries = [];
  const treeLines = [];
  const monthBundle = [];
  const accessNeeded = pkg.accessNeeded || [];

  for (const [fileId, node] of pkg.nodes.entries()) {
    const title = node.title || node.payload?.title || fileId;
    const plain =
      node.payload?.plainText ||
      node.payload?.markdown ||
      node.error ||
      '';
    const likelyRole =
      node.depth === 0
        ? LIKELY_ROLE.CONTEXT
        : node.likelyRole ||
          node.payload?.likelyRole ||
          classifyLikelyRole(title, plain);

    const entry = {
      fileId,
      title,
      kind: node.kind,
      depth: node.depth,
      parentFileId: node.parentFileId,
      url: node.url,
      likelyRole,
      accessNeeded: Boolean(node.accessNeeded),
      error: node.error || null,
      childFileIds: node.childFileIds || [],
    };
    indexEntries.push(entry);

    if (pkg.monthFilter) {
      const modified = node.payload?.raw?.modifiedTime || node.extractedAt;
      const monthHay = pkg.monthFilter.toLowerCase();
      const textMatch = plain.toLowerCase().includes(monthHay);
      if ((modified && isInMonth(modified, pkg.monthFilter)) || textMatch) {
        monthBundle.push({ ...entry, excerpt: plain.slice(0, 2000) });
      }
    }

    const jsonPath = path.join(nodesDir, `${fileId}.json`);
    const mdPath = path.join(nodesDir, `${fileId}.md`);
    const mdBody =
      node.payload?.markdown ||
      (plain ? `# ${title}\n\n${plain}\n` : `# ${title}\n\n${node.error || '_no content_'}\n`);

    await fs.writeFile(
      jsonPath,
      JSON.stringify(
        {
          ...entry,
          extractedAt: node.extractedAt,
          payload: node.payload ? stripHeavyPayload(node.payload) : undefined,
          dryRun: node.dryRun,
        },
        null,
        2,
      ),
      'utf8',
    );
    await fs.writeFile(mdPath, mdBody, 'utf8');

    if (node.kind === FILE_KIND.SPREADSHEET && node.payload?.sheets) {
      const fileSheetsDir = path.join(sheetsDir, fileId);
      await fs.mkdir(fileSheetsDir, { recursive: true });
      for (const tab of node.payload.sheets) {
        const csvName = `${safeFileName(tab.title)}.csv`;
        await fs.writeFile(path.join(fileSheetsDir, csvName), tab.csv || '', 'utf8');
      }
    }
  }

  const rootId = pkg.rootFileId;
  buildTree(rootId, pkg.nodes, 0, treeLines);

  const sortedIndex = sortIndexEntries(indexEntries);
  const taskSources = sortedIndex.filter((e) => e.likelyRole === LIKELY_ROLE.TASK_PLAN);
  const updateSources = sortedIndex.filter((e) => e.likelyRole === LIKELY_ROLE.PROGRESS_UPDATE);
  const contextSources = sortedIndex.filter((e) => e.likelyRole === LIKELY_ROLE.CONTEXT);

  const graph = buildGraph(pkg, sortedIndex);
  const statsByKind = sortedIndex.reduce((acc, e) => {
    acc[e.kind] = (acc[e.kind] || 0) + 1;
    return acc;
  }, {});

  const manifest = {
    runId: pkg.runId,
    rootUrl: pkg.rootUrl,
    root: {
      fileId: pkg.rootFileId,
      url: pkg.rootUrl,
      title: pkg.nodes.get(pkg.rootFileId)?.title || pkg.rootFileId,
    },
    rootFileId: pkg.rootFileId,
    startedAt: pkg.startedAt,
    finishedAt: new Date().toISOString(),
    options: pkg.options,
    stats: {
      nodeCount: pkg.nodes.size,
      accessNeededCount: accessNeeded.length,
      truncated: pkg.truncated,
      docs: statsByKind[FILE_KIND.DOCUMENT] || 0,
      sheets: statsByKind[FILE_KIND.SPREADSHEET] || 0,
      other: sortedIndex.length - (statsByKind[FILE_KIND.DOCUMENT] || 0) - (statsByKind[FILE_KIND.SPREADSHEET] || 0),
      errors: accessNeeded.length,
    },
    graph,
    nodeFileIds: [...pkg.nodes.keys()],
    errors: accessNeeded.map((a) => ({
      fileId: a.fileId,
      reason: a.error || 'access denied',
      url: a.url,
    })),
  };

  const organizedDir = path.join(outDir, 'organized');
  await fs.mkdir(organizedDir, { recursive: true });

  await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await fs.writeFile(path.join(outDir, 'index.json'), JSON.stringify(sortedIndex, null, 2), 'utf8');
  await fs.writeFile(path.join(outDir, 'tree.md'), treeLines.join('\n') + '\n', 'utf8');
  await fs.writeFile(path.join(organizedDir, 'index.json'), JSON.stringify(sortedIndex, null, 2), 'utf8');
  await fs.writeFile(path.join(organizedDir, 'tree.md'), treeLines.join('\n') + '\n', 'utf8');
  await fs.writeFile(
    path.join(organizedDir, 'task-sources.json'),
    JSON.stringify({ count: taskSources.length, items: taskSources }, null, 2),
    'utf8',
  );
  await fs.writeFile(
    path.join(organizedDir, 'update-sources.json'),
    JSON.stringify({ count: updateSources.length, items: updateSources }, null, 2),
    'utf8',
  );
  await fs.writeFile(
    path.join(outDir, 'access-needed.json'),
    JSON.stringify(accessNeeded, null, 2),
    'utf8',
  );

  const monthItems = pkg.monthFilter ? monthBundle : sortedIndex;
  const monthTaskSources = monthItems.filter((e) => e.likelyRole === LIKELY_ROLE.TASK_PLAN);
  const monthUpdateSources = monthItems.filter((e) => e.likelyRole === LIKELY_ROLE.PROGRESS_UPDATE);

  await fs.writeFile(
    path.join(outDir, 'month-bundle.json'),
    JSON.stringify(
      {
        month: pkg.monthFilter || null,
        items: monthItems,
        taskSources: monthTaskSources.length ? monthTaskSources : taskSources,
        updateSources: monthUpdateSources.length ? monthUpdateSources : updateSources,
        contextSources,
      },
      null,
      2,
    ),
    'utf8',
  );

  const report = buildReport(manifest, sortedIndex, accessNeeded);
  await fs.writeFile(path.join(outDir, 'report.md'), report, 'utf8');

  return { manifest, indexEntries: sortedIndex, reportPath: path.join(outDir, 'report.md') };
}

function stripHeavyPayload(payload) {
  const copy = { ...payload };
  if (copy.sheets) {
    copy.sheets = copy.sheets.map((s) => ({
      title: s.title,
      sheetId: s.sheetId,
      rowCount: s.rowCount,
      csvLength: (s.csv || '').length,
    }));
  }
  if (copy.plainText && copy.plainText.length > 5000) {
    copy.plainText = copy.plainText.slice(0, 5000) + '\n…[truncated in manifest node json]';
  }
  return copy;
}

function buildTree(fileId, nodes, depth, lines, seen = new Set()) {
  if (!fileId || seen.has(fileId)) return;
  seen.add(fileId);
  const node = nodes.get(fileId);
  if (!node) return;
  const title = node.title || node.payload?.title || fileId;
  const prefix = '  '.repeat(depth);
  const flag = node.accessNeeded ? ' [access needed]' : node.error ? ' [error]' : '';
  lines.push(`${prefix}- ${title} (\`${fileId}\`)${flag}`);
  for (const childId of node.childFileIds || []) {
    buildTree(childId, nodes, depth + 1, lines, seen);
  }
}

function buildReport(manifest, index, accessNeeded) {
  const byRole = {};
  for (const e of index) {
    byRole[e.likelyRole] = (byRole[e.likelyRole] || 0) + 1;
  }
  const lines = [
    '# Google Knowledge Extraction Report',
    '',
    `- **Run ID:** ${manifest.runId}`,
    `- **Root:** ${manifest.rootUrl}`,
    `- **Nodes:** ${manifest.stats.nodeCount}`,
    `- **Access needed:** ${manifest.stats.accessNeededCount}`,
    `- **Truncated:** ${manifest.stats.truncated}`,
    '',
    '## Role classification',
    '',
    ...Object.entries(byRole).map(([k, v]) => `- ${k}: ${v}`),
    '',
  ];
  if (accessNeeded.length) {
    lines.push('## Files needing access', '');
    for (const a of accessNeeded) {
      lines.push(`- \`${a.fileId}\` — ${a.url || ''} — ${a.error || ''}`);
    }
    lines.push('');
  }
  lines.push('## Index', '');
  for (const e of index) {
    lines.push(`- [${e.title}](nodes/${e.fileId}.md) — ${e.likelyRole} — depth ${e.depth}`);
  }
  lines.push('');
  return lines.join('\n');
}

function isInMonth(isoDate, monthStr) {
  if (!monthStr) return false;
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return false;
  const [y, m] = monthStr.split('-').map(Number);
  return d.getUTCFullYear() === y && d.getUTCMonth() + 1 === m;
}
