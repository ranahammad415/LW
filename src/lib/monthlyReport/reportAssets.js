/**
 * Reserved ClientAsset folders for formal monthly SEO PDF reports.
 */
import { prisma } from '../prisma.js';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { LOCAL_WAVES_CONTACT } from './formalTemplate/brandAssets.js';

export const REPORT_ASSET_FOLDERS = {
  LOGO: 'monthly-report-logo',
  FOLD: 'monthly-report-fold',
};

/** Max size for logo / fold snap uploads (10MB). */
export const REPORT_ASSET_MAX_BYTES = 10 * 1024 * 1024;

/** Prefer data URLs under this size; larger snaps use file:// for Playwright. */
const DATA_URL_MAX_BYTES = 800 * 1024;

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

function mimeFromPath(absolute) {
  const ext = absolute.split('.').pop()?.toLowerCase() || 'png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'svg') return 'image/svg+xml';
  return 'image/png';
}

/**
 * Read an upload as a data URL for embedding in HTML (preview / small files).
 */
export function readUploadAsDataUrl(fileUrl) {
  const absolute = resolveUploadAbsolutePath(fileUrl);
  if (!absolute) return null;
  const buf = readFileSync(absolute);
  return `data:${mimeFromPath(absolute)};base64,${buf.toString('base64')}`;
}

/**
 * Source URL for Playwright PDF HTML.
 * Large fold snaps stay as file:// so setContent does not choke on multi-MB base64.
 * Small files stay data: for portability in HTML previews.
 */
export function readUploadForPdfHtml(fileUrl, { preferFileUrl = false } = {}) {
  const absolute = resolveUploadAbsolutePath(fileUrl);
  if (!absolute) return null;
  const buf = readFileSync(absolute);
  if (preferFileUrl || buf.length > DATA_URL_MAX_BYTES) {
    return pathToFileURL(absolute).href;
  }
  return `data:${mimeFromPath(absolute)};base64,${buf.toString('base64')}`;
}

function isNoreplyEmail(email) {
  return /^(noreply|no-reply|donotreply|do-not-reply)(\+.*)?@/i.test(String(email || '').trim());
}

/**
 * Agency footer contact block for conclusion page.
 * Falls back to public Local Waves contacts from https://localwaves.ai/
 */
export async function getAgencyReportFooter() {
  try {
    const s = await prisma.agencySetting.findFirst();
    if (s) {
      const rawEmail = s.emailFromAddress || null;
      const email =
        rawEmail && !isNoreplyEmail(rawEmail) ? rawEmail : LOCAL_WAVES_CONTACT.email;
      return {
        agencyName: s.agencyName || LOCAL_WAVES_CONTACT.agencyName,
        logoUrl: s.logoUrl || null,
        email,
        phone: s.phone || LOCAL_WAVES_CONTACT.phone,
        address: s.address || LOCAL_WAVES_CONTACT.address,
        website: s.website || LOCAL_WAVES_CONTACT.website,
      };
    }
  } catch {
    /* ignore */
  }
  return { ...LOCAL_WAVES_CONTACT, logoUrl: null };
}
