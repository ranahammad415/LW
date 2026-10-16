/**
 * Contract v1.5.0 §26.1 (D11): leads (quote requests) from EmDash sites. Pure helpers.
 * PII (fields) only ever lives in the CmsLead row: never in logs, receipts, other events, URLs or error messages.
 */

export const LEAD_EVENT_TYPES = Object.freeze(['lead.created', 'lead.erased']);
export const LEAD_LIMITS = Object.freeze({ photos: 5, message: 2000, siteRetentionDaysDefault: 30, osRetentionMonthsDefault: 24, photoUrlTtlDays: 7 });
export const LEAD_ERASE_REASONS = Object.freeze(['subject_request', 'retention', 'spam', 'other']);
export const LEAD_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

// Contract common.json#/$defs/id (opaque ids).
const ULID = /^[A-Za-z0-9_-]{1,64}$/;
const s = (v, max) => (typeof v === 'string' && v.length ? v.slice(0, max) : null);
const date = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Envelope check for lead events. Messages never contain lead data. */
export function validateLeadEvent(ev) {
  if (ev.snapshotText !== undefined) return 'snapshotText is not allowed on lead events';
  if (ev.type === 'lead.created') {
    const l = ev.lead;
    if (!l || typeof l !== 'object') return 'lead is required';
    if (typeof l.leadId !== 'string' || !ULID.test(l.leadId)) return 'lead.leadId is required';
    if (!l.consent || l.consent.contact !== true) return 'lead.consent.contact must be true';
    if (!l.fields || typeof l.fields !== 'object') return 'lead.fields is required';
    if (l.photos !== undefined && (!Array.isArray(l.photos) || l.photos.length > LEAD_LIMITS.photos)) return 'lead.photos must hold at most 5 items';
  }
  if (ev.type === 'lead.erased' && (typeof ev.leadId !== 'string' || !ULID.test(ev.leadId))) return 'leadId is required';
  return null;
}

/** lead → CmsLead columns (+ photo rows). Plain text; unknown keys dropped; lengths capped. */
export function leadToRow(lead, siteId = null) {
  const f = lead.fields || {};
  const extra = {};
  if (f.extra && typeof f.extra === 'object' && !Array.isArray(f.extra)) {
    for (const [k, v] of Object.entries(f.extra).slice(0, 30)) if (typeof v === 'string') extra[String(k).slice(0, 64)] = v.slice(0, 500);
  }
  const utm = lead.source?.utm && typeof lead.source.utm === 'object' ? lead.source.utm : null;
  return {
    row: {
      leadId: lead.leadId,
      siteId: s(siteId, 64),
      formId: s(lead.form?.id, 64),
      formName: s(lead.form?.name, 200),
      sourcePath: typeof lead.source?.path === 'string' && lead.source.path.startsWith('/') ? lead.source.path.slice(0, 500) : null,
      utm: utm
        ? Object.fromEntries(['source', 'medium', 'campaign', 'term', 'content'].filter((k) => typeof utm[k] === 'string').map((k) => [k, utm[k].slice(0, 200)]))
        : null,
      fields: {
        name: s(f.name, 200),
        phone: s(f.phone, 40),
        email: s(f.email, 254),
        town: s(f.town, 100),
        postalCode: s(f.postalCode, 20),
        service: s(f.service, 100),
        message: s(f.message, LEAD_LIMITS.message),
        ...(Object.keys(extra).length ? { extra } : {}),
      },
      consentMarketing: lead.consent?.marketing === true,
      consent: { text: s(lead.consent?.text, 500), version: s(lead.consent?.version, 32), at: s(lead.consent?.at, 40) },
      spamVerdict: lead.spam?.verdict === 'suspect' ? 'suspect' : 'ok',
      spamScore: typeof lead.spam?.score === 'number' ? Math.max(0, Math.min(1, lead.spam.score)) : null,
      siteCreatedAt: date(lead.createdAt),
      siteRetentionDays: Number.isInteger(lead.siteRetentionDays) ? lead.siteRetentionDays : LEAD_LIMITS.siteRetentionDaysDefault,
    },
    photos: (Array.isArray(lead.photos) ? lead.photos : []).slice(0, LEAD_LIMITS.photos)
      .filter((p) => p && typeof p.mediaId === 'string' && typeof p.url === 'string' && p.url.startsWith('https://'))
      .map((p) => ({ mediaId: p.mediaId.slice(0, 64), sourceUrl: p.url.slice(0, 2000), sourceExpiresAt: date(p.expiresAt), contentType: s(p.contentType, 64), bytes: Number.isInteger(p.bytes) ? p.bytes : null })),
  };
}

/** The PII-free part of a lead for analytics (SiteLeadEvent meta). */
export function leadAnalyticsMeta(row) {
  return { source: 'emdash', leadId: row.leadId, formId: row.formId, spam: row.spamVerdict, utm: row.utm || null };
}
