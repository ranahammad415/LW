/**
 * Reserved ClientAsset folders for formal monthly SEO PDF reports.
 */
import { prisma } from '../prisma.js';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export const REPORT_ASSET_FOLDERS = {
  LOGO: 'monthly-report-logo',
  FOLD: 'monthly-report-fold',
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOADS_ROOT = join(__dirname, '..', '..', '..', 'uploads');

/**
 * Latest asset for a client in a reserved report folder.
 */
export async function getLatestReportAsset(clientId, folder) {
  return prisma.clientAsset.findFirst({
    where: { clientId, folder },
    orderBy: { uploadedAt: 'desc' },
  });
}

export async function getClientReportAssets(clientId) {
  const [logo, fold] = await Promise.all([
    getLatestReportAsset(clientId, REPORT_ASSET_FOLDERS.LOGO),
    getLatestReportAsset(clientId, REPORT_ASSET_FOLDERS.FOLD),
  ]);
  return {
    logo: logo
      ? { id: logo.id, fileUrl: logo.fileUrl, filename: logo.filename, uploadedAt: logo.uploadedAt.toISOString() }
      : null,
    fold: fold
      ? { id: fold.id, fileUrl: fold.fileUrl, filename: fold.filename, uploadedAt: fold.uploadedAt.toISOString() }
      : null,
  };
}

/**
 * Resolve a stored /uploads/... URL or path to an absolute filesystem path.
 */
export function resolveUploadAbsolutePath(fileUrl) {
  if (!fileUrl) return null;
  const raw = String(fileUrl);
  const idx = raw.indexOf('/uploads/');
  const rel = idx >= 0 ? raw.slice(idx + '/uploads/'.length) : raw.replace(/^\/+/, '');
  if (!rel || rel.includes('..')) return null;
  const absolute = join(UPLOADS_ROOT, rel.replace(/\\/g, '/'));
  return existsSync(absolute) ? absolute : null;
}

/**
 * Read an upload as a data URL for embedding in Playwright HTML.
 */
export function readUploadAsDataUrl(fileUrl) {
  const absolute = resolveUploadAbsolutePath(fileUrl);
  if (!absolute) return null;
  const buf = readFileSync(absolute);
  const ext = absolute.split('.').pop()?.toLowerCase() || 'png';
  const mime =
    ext === 'jpg' || ext === 'jpeg'
      ? 'image/jpeg'
      : ext === 'webp'
        ? 'image/webp'
        : ext === 'gif'
          ? 'image/gif'
          : ext === 'svg'
            ? 'image/svg+xml'
            : 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * Agency footer contact block for conclusion page.
 * Uses emailFromAddress only when it looks like a public contact (not noreply@).
 */
export async function getAgencyReportFooter() {
  try {
    const s = await prisma.agencySetting.findFirst();
    if (s) {
      const rawEmail = s.emailFromAddress || null;
      const email =
        rawEmail && !/^(noreply|no-reply|donotreply|do-not-reply)(\+.*)?@/i.test(String(rawEmail).trim())
          ? rawEmail
          : null;
      return {
        agencyName: s.agencyName || 'Local Waves',
        logoUrl: s.logoUrl || null,
        email,
        phone: s.phone || null,
        address: s.address || null,
        website: s.website || null,
      };
    }
  } catch {
    /* ignore */
  }
  return {
    agencyName: 'Local Waves',
    logoUrl: null,
    email: null,
    phone: null,
    address: null,
    website: null,
  };
}
