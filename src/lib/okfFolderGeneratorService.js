/**
 * OKF v2 spec folder tree + starter files for a client knowledge base.
 *
 * This is additive over the v1 layout created by knowledgeEngine.initializeClientDirs:
 * existing v1 files are never touched, and starter files are only written where
 * nothing exists yet.
 */
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { KB_BASE_DIR, writeOkfFile, OKF_VERSION } from './knowledgeEngine.js';

const SPEC_FOLDERS = [
  'company',
  'services',
  'products',
  'locations',
  'competitors',
  'faq',
  'voice',
  'proof/case-studies',
  'proof/testimonials',
  'proof/reviews',
  'proof/before-after-results',
  'seo/strategy/history',
  'seo/technical-audits',
  'seo/competitor-audits',
  'seo/local-seo-audits',
  'content/briefs',
  'content/drafts',
  'content/published',
  'content/rejected',
  'reports/monthly',
  'reports/weekly',
  'approvals',
  'knowledge-gaps',
  'agent-feedback',
];

const SPEC_FILES = [
  { folder: 'company', filename: 'profile', title: 'Company Profile' },
  { folder: 'company', filename: 'approved-claims', title: 'Approved Claims' },
  { folder: 'company', filename: 'restricted-claims', title: 'Restricted Claims' },
  { folder: 'company', filename: 'target-audience', title: 'Target Audience' },
  { folder: 'company', filename: 'competitors', title: 'Competitors Overview' },
  { folder: 'voice', filename: 'brand-voice', title: 'Brand Voice' },
  { folder: 'faq', filename: 'customer-questions', title: 'Customer Questions' },
  { folder: 'faq', filename: 'sales-objections', title: 'Sales Objections' },
  { folder: 'faq', filename: 'support-questions', title: 'Support Questions' },
  { folder: 'seo/strategy', filename: 'current', title: 'Current Strategy' },
  { folder: 'seo', filename: 'keyword-map', title: 'Keyword Map' },
  { folder: 'seo', filename: 'service-location-map', title: 'Service Location Map' },
  { folder: 'seo', filename: 'content-map', title: 'Content Map' },
  { folder: 'seo', filename: 'internal-linking-map', title: 'Internal Linking Map' },
];

function buildFrontMatter({ clientId, title, type, status = 'DRAFT' }) {
  return {
    client_id: clientId,
    type,
    title,
    status,
    source: 'SYSTEM_GENERATOR',
    confidence: 0.5,
    restricted_claims_checked: false,
    okf_version: OKF_VERSION,
    schema_type: type,
    created_at: new Date().toISOString(),
  };
}

function specFilePath(clientId, spec) {
  return join(KB_BASE_DIR, clientId, ...spec.folder.split('/'), `${spec.filename}.md`);
}

/**
 * Generate the spec-aligned OKF folder structure for a client.
 * Existing files are left untouched unless `overwrite` is set.
 */
export async function generateOkfSpecStructure(clientId, { agencyName = 'Client', overwrite = false } = {}) {
  const base = join(KB_BASE_DIR, clientId);
  mkdirSync(base, { recursive: true });

  for (const folder of SPEC_FOLDERS) {
    const dir = join(base, ...folder.split('/'));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const created = [];
  const skipped = [];

  for (const spec of SPEC_FILES) {
    if (!overwrite && existsSync(specFilePath(clientId, spec))) {
      skipped.push(`${spec.folder}/${spec.filename}.md`);
      continue;
    }

    const meta = buildFrontMatter({
      clientId,
      title: spec.title,
      type: spec.folder.replace(/\//g, '-'),
    });
    const body = spec.filename === 'profile'
      ? `# ${agencyName}\n\nCompany profile placeholder — complete during intake.`
      : `# ${spec.title}\n\nPlaceholder — populate with approved client knowledge only.`;

    writeOkfFile(clientId, spec.folder, spec.filename, meta, body);
    created.push(`${spec.folder}/${spec.filename}.md`);
  }

  return { clientId, created, skipped, folders: SPEC_FOLDERS };
}

export async function validateOkfSpecCompliance(clientId) {
  const missing = [];
  for (const spec of SPEC_FILES) {
    if (!existsSync(specFilePath(clientId, spec))) {
      missing.push(`${spec.folder}/${spec.filename}.md`);
    }
  }
  return { clientId, compliant: missing.length === 0, missing };
}

export { SPEC_FOLDERS, SPEC_FILES };
