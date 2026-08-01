import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { prisma } from '../prisma.js';
import { renderFormalReportHtml } from './formalTemplate/renderFormalHtml.js';
import {
  getClientReportAssets,
  getAgencyReportFooter,
  readUploadAsDataUrl,
} from './reportAssets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MONTHLY_REPORTS_ROOT = join(__dirname, '..', '..', '..', 'uploads');

function pdfAbsolutePath(storedPath) {
  const normalized = String(storedPath || '').replace(/^\/+/, '').replace(/\\/g, '/');
  if (!normalized || normalized.includes('..')) return null;
  return join(MONTHLY_REPORTS_ROOT, normalized);
}

export function readMonthlyReportPdf(storedPath) {
  const absolute = pdfAbsolutePath(storedPath);
  if (!absolute || !existsSync(absolute)) return null;
  return readFileSync(absolute);
}

export function deleteMonthlyReportPdf(storedPath) {
  const absolute = pdfAbsolutePath(storedPath);
  if (absolute && existsSync(absolute)) unlinkSync(absolute);
}

async function buildHtmlForReport(report) {
  const client = await prisma.clientAccount.findUnique({
    where: { id: report.clientId },
    select: { id: true, agencyName: true, websiteUrl: true },
  });
  if (!client) throw Object.assign(new Error('Client not found'), { statusCode: 404 });

  const assets = await getClientReportAssets(client.id);
  const agency = await getAgencyReportFooter();

  const clientLogoDataUrl = assets.logo ? readUploadAsDataUrl(assets.logo.fileUrl) : null;
  const foldDataUrl = assets.fold ? readUploadAsDataUrl(assets.fold.fileUrl) : null;
  const agencyLogoDataUrl = agency.logoUrl ? readUploadAsDataUrl(agency.logoUrl) : null;

  const html = renderFormalReportHtml({
    aiContent: report.aiContent,
    clientName: client.agencyName,
    websiteUrl: client.websiteUrl,
    month: report.month,
    year: report.year,
    clientLogoDataUrl,
    foldDataUrl,
    agency: {
      ...agency,
      logoDataUrl: agencyLogoDataUrl,
    },
  });

  return { html, client };
}

/**
 * Render formal report HTML to PDF via Playwright Chromium.
 * Set PLAYWRIGHT_PDF=0 to skip (tests). Throws if Playwright unavailable.
 */
export async function renderFormalPdfBuffer(html) {
  if (process.env.PLAYWRIGHT_PDF === '0') {
    throw Object.assign(new Error('PDF rendering disabled (PLAYWRIGHT_PDF=0)'), { statusCode: 503 });
  }

  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    throw Object.assign(
      new Error('Playwright is not installed. Run: npm install playwright && npx playwright install chromium'),
      { statusCode: 503 },
    );
  }

  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

/**
 * Generate PDF for a MonthlyReport, persist path, return updated report.
 */
export async function generateAndStoreFormalPdf(reportId, { log = console } = {}) {
  const report = await prisma.monthlyReport.findUnique({ where: { id: reportId } });
  if (!report) throw Object.assign(new Error('Report not found'), { statusCode: 404 });

  const { html, client } = await buildHtmlForReport(report);
  const buffer = await renderFormalPdfBuffer(html);

  if (report.pdfStoredPath) {
    deleteMonthlyReportPdf(report.pdfStoredPath);
  }

  const monthPad = String(report.month).padStart(2, '0');
  const fileName = `${client.agencyName.replace(/[^\w.\-() ]+/g, '_').slice(0, 80)}-${report.year}-${monthPad}-SEO-Report.pdf`;
  const storedName = `${randomUUID()}-${fileName}`;
  const relDir = join('monthly-reports', report.clientId);
  const absDir = join(MONTHLY_REPORTS_ROOT, relDir);
  mkdirSync(absDir, { recursive: true });
  const storedPath = join(relDir, storedName).replace(/\\/g, '/');
  writeFileSync(join(MONTHLY_REPORTS_ROOT, storedPath), buffer);

  const updated = await prisma.monthlyReport.update({
    where: { id: reportId },
    data: {
      pdfStoredPath: storedPath,
      pdfFileName: fileName,
      pdfFileSize: buffer.length,
      pdfGeneratedAt: new Date(),
    },
  });

  log?.info?.({ reportId, storedPath, bytes: buffer.length }, 'Formal monthly report PDF generated');
  return updated;
}

export async function getFormalReportHtmlPreview(reportId) {
  const report = await prisma.monthlyReport.findUnique({ where: { id: reportId } });
  if (!report) return null;
  const { html } = await buildHtmlForReport(report);
  return html;
}
