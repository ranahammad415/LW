/**
 * Interview settings (owner decisions D5, D6, D7).
 *
 * One `InterviewSetting` row with scope 'AGENCY' holds the agency defaults; a
 * row whose scope is a clientId holds that client's overrides. A null field
 * means "inherit". Resolution order for every field:
 *
 *   client override → agency default → env fallback → built-in default
 *
 * Env vars are fallbacks only (VOICE_AGENT_MONTHLY_MINUTES_PER_CLIENT,
 * INTERVIEW_AGENCY_MONTHLY_MINUTES, INTERVIEW_TRANSCRIPT_RETENTION_DAYS).
 */
import { prisma } from './prisma.js';

export const AGENCY_SCOPE = 'AGENCY';

/** Fields an owner may set. `agencyOnly` fields are ignored on client rows. */
export const SETTING_FIELDS = {
  monthlyMinutesPerClient: { type: 'int', min: 0, max: 100000 },
  agencyMonthlyMinutes: { type: 'int', min: 0, max: 1000000, agencyOnly: true },
  autoApproveLowRisk: { type: 'bool' },
  transcriptRetentionDays: { type: 'int', min: 1, max: 3650 },
  clientCanViewOwnTranscripts: { type: 'bool' },
  clientCanViewWorkerTranscripts: { type: 'bool' },
};

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Built-in defaults, with env vars layered on top as the last-resort fallback. */
export function baseDefaults() {
  return {
    monthlyMinutesPerClient: envInt('VOICE_AGENT_MONTHLY_MINUTES_PER_CLIENT', 120),
    agencyMonthlyMinutes: envInt('INTERVIEW_AGENCY_MONTHLY_MINUTES', 2000),
    // D6: auto-approve of low-risk facts is allowed and defaults ON at agency level.
    autoApproveLowRisk: true,
    transcriptRetentionDays: envInt('INTERVIEW_TRANSCRIPT_RETENTION_DAYS', 365),
    // D7: transcript visibility defaults off.
    clientCanViewOwnTranscripts: false,
    clientCanViewWorkerTranscripts: false,
  };
}

/** Pure merge used by resolveInterviewSettings (exported for tests). */
export function mergeSettings(defaults, agencyRow, clientRow) {
  const out = { ...defaults };
  const sources = {};
  for (const key of Object.keys(SETTING_FIELDS)) {
    sources[key] = 'default';
    if (agencyRow && agencyRow[key] !== null && agencyRow[key] !== undefined) {
      out[key] = agencyRow[key];
      sources[key] = 'agency';
    }
    if (
      !SETTING_FIELDS[key].agencyOnly
      && clientRow
      && clientRow[key] !== null
      && clientRow[key] !== undefined
    ) {
      out[key] = clientRow[key];
      sources[key] = 'client';
    }
  }
  return { ...out, sources };
}

async function findRow(scope) {
  try {
    return await prisma.interviewSetting.findUnique({ where: { scope } });
  } catch {
    // Table may not exist until the migration is applied; fall back to defaults.
    return null;
  }
}

/** Effective settings for a client (or agency-level when clientId is null). */
export async function resolveInterviewSettings(clientId = null) {
  const [agencyRow, clientRow] = await Promise.all([
    findRow(AGENCY_SCOPE),
    clientId ? findRow(clientId) : Promise.resolve(null),
  ]);
  return mergeSettings(baseDefaults(), agencyRow, clientRow);
}

/** Validates an owner-supplied patch. Returns {data} or {error}. */
export function sanitizeSettingsPatch(patch, { isAgency }) {
  const data = {};
  if (!patch || typeof patch !== 'object') return { data };
  for (const [key, spec] of Object.entries(SETTING_FIELDS)) {
    if (!(key in patch)) continue;
    if (spec.agencyOnly && !isAgency) continue;
    const value = patch[key];
    if (value === null) {
      data[key] = null;
      continue;
    }
    if (spec.type === 'bool') {
      if (typeof value !== 'boolean') return { error: `${key} must be true, false or null` };
      data[key] = value;
    } else {
      const n = Number(value);
      if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
        return { error: `${key} must be a whole number between ${spec.min} and ${spec.max}` };
      }
      data[key] = n;
    }
  }
  return { data };
}

export async function upsertInterviewSettings(scope, data, userId) {
  const clientId = scope === AGENCY_SCOPE ? null : scope;
  return prisma.interviewSetting.upsert({
    where: { scope },
    create: { scope, clientId, ...data, updatedById: userId || null },
    update: { ...data, updatedById: userId || null },
  });
}

export async function deleteClientOverride(clientId) {
  return prisma.interviewSetting.deleteMany({ where: { scope: clientId } });
}

export async function listInterviewSettingRows() {
  try {
    return await prisma.interviewSetting.findMany({ orderBy: { updatedAt: 'desc' } });
  } catch {
    return [];
  }
}
