import { prisma } from './prisma.js';
import { notify } from './notificationService.js';
import {
  deleteHtmlReportFile,
  isValidReportMonth,
  readHtmlReportFile,
  saveHtmlReportFile,
  validateHtmlReportUpload,
} from './htmlReportUpload.js';

export function serializeHtmlReport(report) {
  return {
    id: report.id,
    projectId: report.projectId,
    projectName: report.project?.name ?? null,
    month: report.month,
    title: report.title,
    fileName: report.fileName,
    fileSize: report.fileSize,
    status: report.status,
    uploadedBy: report.uploadedBy
      ? { id: report.uploadedBy.id, name: report.uploadedBy.name }
      : null,
    createdAt: report.createdAt.toISOString(),
    updatedAt: report.updatedAt.toISOString(),
  };
}

export async function getHtmlReportWithRelations(id) {
  return prisma.projectHtmlReport.findUnique({
    where: { id },
    include: {
      project: { select: { id: true, name: true, clientId: true, leadPmId: true } },
      uploadedBy: { select: { id: true, name: true } },
    },
  });
}

export async function findHtmlReportByProjectMonth(projectId, month) {
  return prisma.projectHtmlReport.findUnique({
    where: { projectId_month: { projectId, month } },
    include: {
      project: { select: { id: true, name: true, clientId: true } },
      uploadedBy: { select: { id: true, name: true } },
    },
  });
}

export async function canPmAccessProject(user, projectId) {
  if (!user || user.role === 'OWNER') return true;
  if (user.role !== 'PM') return false;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      leadPmId: true,
      client: { select: { leadPmId: true, secondaryPmId: true } },
    },
  });
  if (!project) return false;
  return (
    project.leadPmId === user.id ||
    project.client?.leadPmId === user.id ||
    project.client?.secondaryPmId === user.id
  );
}

export async function canClientAccessHtmlReport(clientIds, report) {
  if (!report || report.status !== 'DELIVERED') return false;
  return clientIds?.includes(report.project?.clientId);
}

export async function upsertProjectHtmlReport({
  projectId,
  month,
  fileName,
  mimetype,
  buffer,
  uploadedById,
}) {
  if (!isValidReportMonth(month)) {
    throw Object.assign(new Error('Invalid month, expected YYYY-MM'), { statusCode: 400 });
  }

  const validation = validateHtmlReportUpload({
    mimetype,
    filename: fileName,
    size: buffer.length,
  });
  if (!validation.ok) {
    throw Object.assign(new Error(validation.message), { statusCode: 400 });
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, clientId: true },
  });
  if (!project) {
    throw Object.assign(new Error('Project not found'), { statusCode: 404 });
  }

  const existing = await prisma.projectHtmlReport.findUnique({
    where: { projectId_month: { projectId, month } },
  });
  if (existing) {
    deleteHtmlReportFile(existing.storedPath);
  }

  const { storedPath } = saveHtmlReportFile({
    projectId,
    month,
    filename: fileName,
    buffer,
  });

  const title = `${project.name} — ${month}`;
  const data = {
    title,
    fileName,
    storedPath,
    fileSize: buffer.length,
    status: 'DELIVERED',
    uploadedById,
  };

  const report = existing
    ? await prisma.projectHtmlReport.update({
        where: { id: existing.id },
        data,
        include: {
          project: { select: { id: true, name: true, clientId: true } },
          uploadedBy: { select: { id: true, name: true } },
        },
      })
    : await prisma.projectHtmlReport.create({
        data: { projectId, month, ...data },
        include: {
          project: { select: { id: true, name: true, clientId: true } },
          uploadedBy: { select: { id: true, name: true } },
        },
      });

  await notifyClientsHtmlReportPublished(report);
  return report;
}

export async function deleteProjectHtmlReport(id) {
  const report = await prisma.projectHtmlReport.findUnique({ where: { id } });
  if (!report) return null;
  deleteHtmlReportFile(report.storedPath);
  await prisma.projectHtmlReport.delete({ where: { id } });
  return report;
}

export async function notifyClientsHtmlReportPublished(report) {
  try {
    const client = await prisma.clientAccount.findUnique({
      where: { id: report.project.clientId },
      include: { clientUsers: { select: { userId: true } } },
    });
    if (!client?.clientUsers?.length) return;
    const [year, mon] = report.month.split('-');
    await notify({
      slug: 'report_published',
      recipientIds: client.clientUsers.map((cu) => cu.userId),
      variables: {
        reportTitle: `${report.title || report.project.name} (${mon}/${year})`,
        clientName: client.agencyName || '',
      },
      actionUrl: '/portal/client/reports',
      metadata: { htmlReportId: report.id, projectId: report.projectId },
    });
  } catch {
    // non-fatal
  }
}

export function getHtmlReportContent(report) {
  return readHtmlReportFile(report.storedPath);
}
