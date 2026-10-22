/**
 * Signals pipeline against an in-memory Prisma stand-in (tests/unit/signals/fakePrisma.js):
 * ingest idempotency (duplicate batch, inner duplicates, counters), sessionizer idempotency and out-of-order arrival,
 * CAS claims, attribution (last non-direct within 30 days, mismatch, first-write-wins, parking), dirty-date rollup
 * equality, bot re-scoring at session level, retention / compaction batches, erasure completeness (no row left for a
 * visitorId; LeadAttribution erased in the same transaction as the lead), the client allow-list.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { takeShapeViolations } from '../../helpers/prismaShape.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../../src/lib/prisma.js', async () => {
  const { createFakePrisma } = await import('./fakePrisma.js');
  return { prisma: createFakePrisma() };
});
const site = vi.hoisted(() => ({ handler: null, calls: [] }));
vi.mock('../../../src/lib/cmsStore.js', async (orig) => ({
  ...(await orig()),
  loadEmdashConnection: async () => ({ conn: { siteId: 'site_9f3c2a7b41d0', siteUrl: 'https://oasispoolspas.com' } }),
}));
vi.mock('../../../src/lib/siteAdapters/emdash.js', async (orig) => {
  const o = await orig();
  const call = (route) => async (_c, body, opts) => {
    site.calls.push({ route, body, opts });
    return site.handler(route, body, opts);
  };
  return { ...o, emdashRoutes: { ...o.emdashRoutes, signalsErase: call('signals-erase'), leadErase: call('lead-erase'), signalsConfigSet: call('signals-config-set'), signalsConfigGet: (c, opts) => call('signals-config-get')(c, {}, opts) } };
});

import { prisma } from '../../../src/lib/prisma.js';
import { ingestSignalsBatch, applySignalsErased, sha256 } from '../../../src/lib/signals/ingest.js';
import { runSessionizer, sessionizeOnce, releaseStaleClaims, claimValue, buildSession } from '../../../src/lib/signals/sessionize.js';
import { attributeLeads, upsertSiteAttribution, applyLeadAttributed, attributionSentence, deriveAttribution, mergeSnapshot } from '../../../src/lib/signals/attribution.js';
import { runRollup, rollupDay, computeDay } from '../../../src/lib/signals/rollup.js';
import { runRetention } from '../../../src/lib/signals/retention.js';
import { runBotRescore } from '../../../src/lib/signals/bots.js';
import { eraseVisitor, retryPendingSignalErasures } from '../../../src/lib/signals/erase.js';
import { clientSignalsView, clientDailyCsv, staffCsv, sessionTimeline, listSessions } from '../../../src/lib/signals/views.js';
import { leadsBySource, llmReferralSessions, fieldVitals, p75 } from '../../../src/lib/signals/metrics.js';
import { applyLeadEvent, eraseLocalLead } from '../../../src/lib/cmsLeads.js';
import { CmsBridgeError } from '../../../src/lib/siteAdapters/emdash.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ex = (name) => JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract/examples', `${name}.json`), 'utf8'));
const SITE = 'site_9f3c2a7b41d0';
const PROJECT = { id: 'p1', cmsSiteId: SITE, cmsType: 'EMDASH', cmsCapabilities: { signals: true }, wpUrl: 'https://oasispoolspas.com' };
const TEMPLATES = Object.fromEntries(ex('events.request--signals').events[0].data.events.reverse().map((e) => [e.type, e])); // first of each type wins
const LEAD = '01JB3QLEAD0000000000000001';
const VISITOR = 'v_01JB2R1S3T5V7X9Z1B3D5F7H9K';
const rows = (name) => prisma._rows(name);

let n = 0;
const ulid = () => `01JB3Q${String((n += 1)).padStart(20, '0')}`;
const sid = (k) => `s_01JB3Q${String(k).padStart(20, '0')}`;

/** A signal of `type` from the example templates with overrides. */
function sig(type, { at, sessionId = sid(1), visitorId = VISITOR, path: p, refClass, refSource, botScore, leadId, eventId } = {}) {
  const s = structuredClone(TEMPLATES[type]);
  s.eventId = eventId || ulid();
  s.sessionId = sessionId;
  s.visitorId = visitorId;
  if (!visitorId) {
    s.consent = { analytics: false, source: 'gpc' };
    if (s.network) s.network.ipHash = null;
  } else s.consent = { analytics: true, source: 'default-us' };
  if (at) s.ts = new Date(at).toISOString();
  if (p && s.page) s.page.path = p;
  if (refClass && s.referrer) s.referrer = { ...s.referrer, class: refClass, source: refSource ?? null, url: refClass === 'direct' ? null : s.referrer.url };
  if (botScore !== undefined) s.bot = { score: botScore, reason: botScore >= 70 ? ['ua_bot'] : [] };
  if (leadId !== undefined && s.lead) s.lead = { ...s.lead, leadId };
  return s;
}
const batch = (signals, batchId = ulid()) => ({ type: 'signals.batch', eventId: ulid(), data: { batchId, table: '1.0.0', count: signals.length, events: signals } });
const ingest = (signals) => ingestSignalsBatch(PROJECT, batch(signals), { now: new Date('2026-10-22T16:00:00Z') });

/** A full visit (session 1): ChatGPT → 2 pages → engagement → CTA → form → lead. */
function chatgptSession(k = 1, day = '2026-10-22', { visitorId = VISITOR, leadId = LEAD } = {}) {
  const t = (hm) => `${day}T${hm}:00.000Z`;
  return [
    sig('visit', { at: t('14:03'), sessionId: sid(k), visitorId }),
    sig('pageview', { at: t('14:03'), sessionId: sid(k), visitorId }),
    sig('pageview', { at: t('14:05'), sessionId: sid(k), visitorId, path: '/spa-services/hot-tub-repair/' }),
    sig('engagement', { at: t('14:06'), sessionId: sid(k), visitorId }),
    sig('cta_click', { at: t('14:06'), sessionId: sid(k), visitorId }),
    sig('form_start', { at: t('14:06'), sessionId: sid(k), visitorId }),
    ...(leadId ? [sig('lead_submitted', { at: t('14:07'), sessionId: sid(k), visitorId, leadId })] : []),
  ];
}

beforeEach(() => {
  prisma._reset();
  site.calls = [];
  site.handler = async () => ({ ok: true, rows: 3, alreadyGone: false });
  n = 0;
});

describe('ingest (signals.batch)', () => {
  it('stores each signal once: a re-sent batch and inner duplicates are ignored silently, counters add up', async () => {
    const signals = chatgptSession();
    await ingest([...signals, signals[1]]); // inner duplicate in the same batch
    expect(rows('signalEvent')).toHaveLength(signals.length);
    await ingest(signals); // the whole batch again (outbox retry)
    expect(rows('signalEvent')).toHaveLength(signals.length);
    const [stat] = rows('signalIngestStat');
    expect(stat).toMatchObject({ batches: 2, events: signals.length, innerDuplicates: signals.length + 1, rejectedInvalid: 0 });
  });

  it('an invalid inner signal is dropped and counted; an unusable batch is a final VALIDATION', async () => {
    await ingest([sig('visit'), { ...sig('pageview'), eventId: 'bad' }]);
    expect(rows('signalEvent')).toHaveLength(1);
    expect(rows('signalIngestStat')[0].rejectedInvalid).toBe(1);
    await expect(ingestSignalsBatch(PROJECT, { type: 'signals.batch', data: { batchId: 'nope', events: [] } })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('a compacted replay (events: []) is accepted with nothing stored', async () => {
    expect(await ingestSignalsBatch(PROJECT, { type: 'signals.batch', data: { batchId: ulid(), table: '1.0.0', count: 40, compacted: true, events: [] } })).toBe('applied');
    expect(rows('signalEvent')).toHaveLength(0);
  });

  it('the internal BIGINT id never leaves a view or an export', async () => {
    await ingest(chatgptSession());
    await runSessionizer({ now: new Date('2026-10-22T16:05:00Z') });
    const tl = await sessionTimeline('p1', sid(1));
    expect(() => JSON.stringify(tl)).not.toThrow();
    expect(JSON.stringify(tl)).not.toMatch(/"id":/);
    const csv = await staffCsv('p1', { from: '2026-10-01', to: '2026-11-01' });
    expect(csv).not.toMatch(/payload/);
  });
});

describe('sessionizer', () => {
  it('builds the session from all its events; re-running changes nothing (idempotent)', async () => {
    await ingest(chatgptSession());
    await runSessionizer({ now: new Date('2026-10-22T16:05:00Z') });
    const first = structuredClone(rows('signalSession'));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ sessionId: sid(1), refClass: 'ai', refSource: 'chatgpt', landingPath: '/spa-services/', exitPath: '/spa-services/hot-tub-repair/', pageviews: 2, ctaClicks: 1, formStarts: 1, engaged: true, leadId: LEAD, isNewVisitor: true, country: 'US', region: 'WI', city: 'Waukesha', localHour: 9 });
    expect(rows('signalEvent').every((e) => e.sessionizedAt && e.sessionizedAt.getUTCFullYear() > 2000)).toBe(true);
    // force a rebuild of the same events
    for (const e of rows('signalEvent')) e.sessionizedAt = null;
    await runSessionizer({ now: new Date('2026-10-22T16:10:00Z') });
    const again = rows('signalSession');
    const strip = (s) => ({ ...s, updatedAt: null, createdAt: null, id: null });
    expect(again.map(strip)).toEqual(first.map(strip));
  });

  it('out-of-order arrival yields the same session as in-order arrival', async () => {
    const signals = chatgptSession();
    await ingest(signals.slice(3)); // later events first
    await runSessionizer({ now: new Date('2026-10-22T16:05:00Z') });
    await ingest(signals.slice(0, 3)); // then the visit and page views
    await runSessionizer({ now: new Date('2026-10-22T16:10:00Z') });
    const late = { ...rows('signalSession')[0] };
    prisma._reset();
    await ingest(signals);
    await runSessionizer({ now: new Date('2026-10-22T16:05:00Z') });
    const inOrder = rows('signalSession')[0];
    const pickS = (s) => ({ startedAt: s.startedAt, endedAt: s.endedAt, landingPath: s.landingPath, refClass: s.refClass, refSource: s.refSource, pageviews: s.pageviews, ctaClicks: s.ctaClicks, formStarts: s.formStarts, leadId: s.leadId, touch: s.touch });
    expect(pickS(late)).toEqual(pickS(inOrder));
  });

  it('an earlier session arriving late makes the later one "not new"', async () => {
    await ingest(chatgptSession(2, '2026-10-22', { leadId: null }));
    await runSessionizer({ now: new Date('2026-10-22T16:05:00Z') });
    expect(rows('signalSession')[0].isNewVisitor).toBe(true);
    await ingest(chatgptSession(1, '2026-10-20', { leadId: null }));
    await runSessionizer({ now: new Date('2026-10-22T16:10:00Z') });
    const byId = Object.fromEntries(rows('signalSession').map((s) => [s.sessionId, s]));
    expect(byId[sid(1)].isNewVisitor).toBe(true);
    expect(byId[sid(2)].isNewVisitor).toBe(false);
    expect(rows('signalRollupDirty').map((r) => r.date.toISOString().slice(0, 10)).sort()).toEqual(['2026-10-20', '2026-10-22']);
  });

  it('claims are compare-and-set: rows claimed by another run are not taken; stale claims are released', async () => {
    await ingest(chatgptSession());
    const now = new Date('2026-10-22T16:05:00Z');
    const other = claimValue(new Date(now.getTime() - 20 * 60_000), 1);
    for (const e of rows('signalEvent')) e.sessionizedAt = other; // a run that died 20 min ago
    expect(await sessionizeOnce({ now })).toBe(0);
    expect(await releaseStaleClaims(now)).toBe(rows('signalEvent').length);
    expect(await sessionizeOnce({ now })).toBe(rows('signalEvent').length);
  });

  it('session-only visits keep no visitor id; internal referrers are never a touch (direct / none)', () => {
    const s = buildSession('p1', sid(9), [{ type: 'visit', at: new Date('2026-10-22T10:00:00Z'), refClass: 'internal', refSource: 'self', pagePath: '/', payload: {}, botScore: 0 }], null);
    expect(s.touch).toMatchObject({ class: 'direct', source: 'none' });
    expect(s.sessionOnly).toBe(true);
  });
});

async function storeLead({ attribution = 'example', extra = null, leadId = LEAD } = {}) {
  const lead = structuredClone(ex('events.request--lead-attribution').events[0].lead);
  lead.leadId = leadId;
  lead.createdAt = '2026-10-22T14:07:12Z';
  if (attribution === null) delete lead.attribution;
  else if (attribution !== 'example') lead.attribution = attribution;
  if (extra) lead.fields.extra = extra;
  return applyLeadEvent(PROJECT, { type: 'lead.created', lead });
}

describe('lead attribution', () => {
  it('lead.created.attribution + lead.attributed: first write wins per field; heard_from kept', async () => {
    await storeLead({ extra: { heard_from: 'AI assistant (ChatGPT, Perplexity…)' } });
    const [a] = rows('leadAttribution');
    expect(a).toMatchObject({ siteLeadId: LEAD, model: 'site-snapshot', lastClass: 'ai', lastSource: 'chatgpt', heardFrom: 'AI assistant (ChatGPT, Perplexity…)', needsDerive: true });
    const attributed = ex('events.request--signals').events.find((e) => e.type === 'lead.attributed');
    const changed = structuredClone(attributed.data);
    changed.attribution.lastTouch.source = 'perplexity'; // a later event never overwrites a stored field
    expect(await applyLeadAttributed(PROJECT, { data: changed })).toBe('applied');
    expect(rows('leadAttribution')[0].siteSnapshot.lastTouch.source).toBe('chatgpt');
    expect(rows('leadAttribution')[0].sitePath.pagesBefore.length).toBeGreaterThan(0);
  });

  it('a cookie-only snapshot is upgraded by a site-snapshot one', () => {
    const cookie = { model: 'cookie-only', firstTouch: null, lastTouch: { at: '2026-10-22T14:03:11.000Z', class: 'direct', source: 'none', campaign: null, medium: null, landing: '/' }, sessionId: null, visitorId: null, landing: null, formId: 'quote', placement: null };
    const snap = { ...cookie, model: 'site-snapshot', lastTouch: { ...cookie.lastTouch, class: 'ai', source: 'chatgpt' }, landing: '/spa-services/' };
    expect(mergeSnapshot(cookie, snap)).toMatchObject({ model: 'site-snapshot', lastTouch: { source: 'chatgpt' }, landing: '/spa-services/' });
  });

  it('lead.attributed for a lead we do not hold yet is parked (retryable), never inserted orphaned; an erased lead gets none', async () => {
    const attributed = ex('events.request--signals').events.find((e) => e.type === 'lead.attributed');
    await expect(applyLeadEvent(PROJECT, { type: 'lead.attributed', data: attributed.data })).rejects.toMatchObject({ code: 'LEAD_NOT_STORED' });
    expect(rows('leadAttribution')).toHaveLength(0);
    await storeLead({ attribution: null });
    await eraseLocalLead('p1', LEAD, 'subject_request');
    expect(await applyLeadEvent(PROJECT, { type: 'lead.attributed', data: attributed.data })).toBe('stale');
    expect(rows('leadAttribution')).toHaveLength(0);
  });

  it('os-derived: last non-direct click within 30 days; first touch from the earliest session; mismatch vs the snapshot', async () => {
    // day 1: Google search visit; day 3: a direct visit that converts
    const google = [sig('visit', { at: '2026-10-19T22:10:00Z', sessionId: sid(1), refClass: 'search', refSource: 'google' }), sig('pageview', { at: '2026-10-19T22:10:00Z', sessionId: sid(1) })];
    const direct = [
      sig('visit', { at: '2026-10-22T14:03:00Z', sessionId: sid(2), refClass: 'direct', refSource: 'none' }),
      sig('pageview', { at: '2026-10-22T14:03:00Z', sessionId: sid(2), path: '/spa-services/' }),
      sig('pageview', { at: '2026-10-22T14:05:00Z', sessionId: sid(2), path: '/contact/' }),
      sig('lead_submitted', { at: '2026-10-22T14:07:12Z', sessionId: sid(2), leadId: LEAD }),
    ];
    await ingest([...google, ...direct]);
    await storeLead(); // site snapshot says chatgpt
    await runSessionizer({ now: new Date('2026-10-22T16:05:00Z') });
    await attributeLeads({ now: new Date('2026-10-22T16:05:00Z') });
    const [a] = rows('leadAttribution');
    expect(a).toMatchObject({ model: 'os-derived', lastClass: 'search', lastSource: 'google', sessionId: sid(2), sessionsBeforeLead: 1, pageviewsBeforeLead: 2, mismatch: true, needsDerive: false });
    expect(a.firstTouch).toMatchObject({ class: 'search', source: 'google' });
    expect(a.sessionToLeadSec).toBe(252);
    const lines = attributionSentence(a);
    expect(lines[0]).toBe('Came from Google Search → landed on /spa-services/ → 2 pages in 4 min → quote form (contact panel)');
    expect(lines).toHaveLength(1); // first touch = the (last non-direct) Google visit: no second line
  });

  it('a direct touch older than 30 days does not get replaced', () => {
    const lead = { leadAt: new Date('2026-10-22T14:00:00Z'), siteSnapshot: null };
    const old = { sessionId: sid(1), startedAt: new Date('2026-09-01T10:00:00Z'), touch: { at: '2026-09-01T10:00:00.000Z', class: 'social', source: 'facebook', landing: '/' }, landingPath: '/' };
    const now = { sessionId: sid(2), startedAt: new Date('2026-10-22T13:50:00Z'), touch: { at: '2026-10-22T13:50:00.000Z', class: 'direct', source: 'none', landing: '/x/' }, landingPath: '/x/' };
    expect(deriveAttribution(lead, now, [old, now], []).lastTouch.class).toBe('direct');
    const recent = { ...old, startedAt: new Date('2026-10-10T10:00:00Z'), touch: { ...old.touch, at: '2026-10-10T10:00:00.000Z' } };
    expect(deriveAttribution(lead, now, [recent, now], []).lastTouch).toMatchObject({ class: 'social', source: 'facebook' });
  });

  it('cookie-only: "Source recorded on the website: ChatGPT"', () => {
    expect(attributionSentence({ model: 'cookie-only', siteSnapshot: { lastTouch: { class: 'ai', source: 'chatgpt' } } })[0]).toBe('Source recorded on the website: ChatGPT');
  });
});

describe('rollup (dirty dates)', () => {
  it('recomputes exactly the dirty days; a re-run gives identical rows (rollup equality); bots excluded, visitors distinct per day', async () => {
    await ingest([
      ...chatgptSession(1, '2026-10-22'),
      ...chatgptSession(2, '2026-10-22', { leadId: null }), // same visitor, second session that day
      ...chatgptSession(3, '2026-10-22', { visitorId: null, leadId: null }), // session-only
      sig('visit', { at: '2026-10-22T18:00:00Z', sessionId: sid(4), visitorId: 'v_01JB2R1S3T5V7X9Z1B3D5F7H00', botScore: 95 }),
    ]);
    await storeLead();
    await runSessionizer({ now: new Date('2026-10-22T19:00:00Z') });
    await attributeLeads({ now: new Date('2026-10-22T19:00:00Z') });
    expect(rows('signalRollupDirty').map((r) => r.date.toISOString().slice(0, 10))).toEqual(['2026-10-22']);
    await runRollup({ now: new Date('2026-10-23T03:30:00Z') });
    expect(rows('signalRollupDirty')).toHaveLength(0);
    const snap = () => rows('signalDailyBySource').map(({ id, createdAt, updatedAt, ...r }) => r).sort((a, b) => a.refClass.localeCompare(b.refClass));
    const first = snap();
    const ai = first.find((r) => r.refClass === 'ai');
    expect(ai).toMatchObject({ sessions: 3, visitors: 2, leads: 1, pageviews: 6, formStarts: 3 });
    expect(first.reduce((n, r) => n + r.botSessions, 0)).toBe(1);
    await rollupDay('p1', new Date('2026-10-22T00:00:00Z'));
    expect(snap()).toEqual(first);
    expect(rows('signalDailyByLanding').find((r) => r.landingPath === '/spa-services/')).toMatchObject({ sessions: 3, leads: 1 });
    expect(rows('signalDailyByGeoDevice')[0]).toMatchObject({ country: 'US', region: 'WI', formFactor: 'phone' });
    expect(Object.keys(rows('signalDailyByGeoDevice')[0])).not.toContain('city');
  });

  it('computeDay is pure and sums sessions, not visitors', () => {
    const s = (v, extra = {}) => ({ visitorId: v, refClass: 'search', refSource: 'google', botScore: 0, isNewVisitor: false, pageviews: 1, engaged: false, ctaClicks: 0, formStarts: 0, landingPath: '/', country: 'US', region: 'WI', formFactor: 'phone', ...extra });
    const out = computeDay('p1', new Date('2026-10-22'), [s('v_a'), s('v_a'), s(null), s(null, { botScore: 80 })], []);
    expect(out.bySource[0]).toMatchObject({ sessions: 3, visitors: 2, botSessions: 1 });
  });
});

describe('bots (session level only)', () => {
  it('raises SignalSession.botScore for a prefix burst; SignalEvent rows keep their capture score', async () => {
    const many = [];
    for (let k = 10; k < 62; k += 1) {
      const v = sig('visit', { at: '2026-10-22T05:00:00Z', sessionId: sid(k), visitorId: null });
      v.device.ua = 'other';
      many.push(v);
    }
    await ingest(many);
    await runSessionizer({ now: new Date('2026-10-22T06:00:00Z'), maxBatches: 5 });
    const before = rows('signalEvent').map((e) => e.botScore);
    const out = await runBotRescore({ now: new Date('2026-10-23T03:10:00Z') });
    expect(out.changed).toBe(52);
    expect(rows('signalSession').every((s) => s.botScore >= 70)).toBe(true);
    expect(rows('signalEvent').map((e) => e.botScore)).toEqual(before);
  });
});

describe('retention and compaction', () => {
  it('compacts payloads after 90 days in batches, deletes compacted short rows, keeps visits to 13 months, sessions 25 months, aggregates 3 years', async () => {
    const now = new Date('2026-10-22T04:00:00Z');
    await ingest([
      ...chatgptSession(1, '2026-06-01', { leadId: null }), // > 90 days
      sig('visit', { at: '2025-08-01T10:00:00Z', sessionId: sid(2) }), // > 13 months
      ...chatgptSession(3, '2026-10-20', { leadId: null }), // fresh
    ]);
    rows('signalSession').push({ id: 'old', projectId: 'p1', sessionId: sid(7), startedAt: new Date('2024-08-01T00:00:00Z') });
    rows('signalDailyBySource').push({ id: 'agg', projectId: 'p1', date: new Date('2023-09-01T00:00:00Z'), refClass: 'ai', refSource: '' });
    rows('project').push({ id: 'p1' });
    const out = await runRetention({ now, batch: 2, pauseMs: 0 });
    expect(out.compacted).toBe(7); // 6 June rows + the 2025 visit, two at a time
    const left = rows('signalEvent');
    expect(left.some((e) => e.at < new Date('2025-10-01'))).toBe(false);
    const june = left.filter((e) => e.at.toISOString().startsWith('2026-06'));
    expect(june.map((e) => e.type).sort()).toEqual(['cta_click', 'form_start', 'visit']);
    expect(june.every((e) => e.payload === null && e.payloadCompactedAt)).toBe(true);
    expect(left.filter((e) => e.at.toISOString().startsWith('2026-10')).every((e) => e.payload)).toBe(true);
    expect(rows('signalSession').find((s) => s.id === 'old')).toBeUndefined();
    expect(rows('signalDailyBySource')).toHaveLength(0);
    expect(out.oldestUncompactedAt).toMatch(/^2026-10-20/);
  });

  it('sweeps rows of a deleted project (no foreign key on the signal tables)', async () => {
    await ingest(chatgptSession());
    const out = await runRetention({ now: new Date('2026-10-22T04:00:00Z'), pauseMs: 0 });
    expect(out.deleted.orphans).toBeGreaterThan(0);
    expect(rows('signalEvent')).toHaveLength(0);
  });
});

describe('erasure', () => {
  it('by visitorId: our copy first (no row left), hash-only record, then the site; retried until acknowledged', async () => {
    await ingest([...chatgptSession(1), ...chatgptSession(2, '2026-10-22', { visitorId: 'v_01JB2R1S3T5V7X9Z1B3D5F7H00', leadId: null })]);
    await storeLead();
    await runSessionizer({ now: new Date('2026-10-22T16:05:00Z') });
    site.handler = async () => {
      throw new CmsBridgeError({ status: 503, code: 'UPSTREAM_UNAVAILABLE', message: 'down' });
    };
    const user = { id: '0f1e2d3c-4b5a-4968-8776-655443322110', name: 'Sam Owner', role: 'OWNER' };
    rows('project').push({ id: 'p1', cmsRepairNeededAt: null });
    const out = await eraseVisitor({ projectId: 'p1', visitorId: VISITOR, reason: 'subject_request', user });
    expect(out).toMatchObject({ erased: true, site: 'pending' });
    expect(rows('signalEvent').some((e) => e.visitorId === VISITOR)).toBe(false);
    expect(rows('signalSession').some((s) => s.visitorId === VISITOR)).toBe(false);
    expect(rows('signalEvent').length).toBeGreaterThan(0); // the other visitor stays
    expect(rows('leadAttribution')[0].visitorId).toBeNull();
    const [er] = rows('signalErasure');
    expect(er).toMatchObject({ kind: 'visitorId', subjectHash: sha256(VISITOR), siteState: 'pending', pendingSubject: VISITOR });
    expect(site.calls[0]).toMatchObject({ route: 'signals-erase', body: { visitorId: VISITOR, reason: 'subject_request', actor: { kind: 'human' } } });
    // the leader job retries as the OS erasure job (actor kind system) with the same idempotency key
    site.handler = async () => ({ ok: true, rows: 9, alreadyGone: false });
    const retry = await retryPendingSignalErasures({ now: new Date(Date.now() + 3600_000) });
    expect(retry.done).toBe(1);
    expect(site.calls[1].body.actor.kind).toBe('system');
    expect(site.calls[1].opts.idempotencyKey).toBe(site.calls[0].opts.idempotencyKey);
    expect(rows('signalErasure')[0]).toMatchObject({ siteState: 'done', siteRows: 9, pendingSubject: null });
    expect(JSON.stringify(rows('signalErasure'))).not.toContain(VISITOR);
  });

  it('signals.erased from the site (Reset my id) erases our copy too and records the hash only', async () => {
    await ingest(chatgptSession(1, '2026-10-22', { leadId: null }));
    await runSessionizer({ now: new Date('2026-10-22T16:05:00Z') });
    const ev = { type: 'signals.erased', data: { kind: 'visitorId', subjectHash: sha256(VISITOR), rows: 4, reason: 'visitor_reset', at: '2026-10-22T17:00:00Z' } };
    await applySignalsErased(PROJECT, ev, { resolveVisitor: async (_p, h) => (h === sha256(VISITOR) ? VISITOR : null) });
    expect(rows('signalEvent')).toHaveLength(0);
    expect(rows('signalSession')).toHaveLength(0);
    expect(rows('signalErasure')[0]).toMatchObject({ origin: 'site', reason: 'visitor_reset', siteState: 'done' });
  });

  it('a lead erasure deletes its LeadAttribution in the same transaction and unlinks the visit rows', async () => {
    await ingest(chatgptSession());
    await storeLead();
    await runSessionizer({ now: new Date('2026-10-22T16:05:00Z') });
    prisma._txCalls.length = 0;
    expect(await eraseLocalLead('p1', LEAD, 'subject_request')).toBe(true);
    expect(prisma._txCalls).toHaveLength(1);
    expect(Array.isArray(prisma._txCalls[0])).toBe(true);
    expect(prisma._txCalls[0]).toHaveLength(5); // photos, attribution, event + session links, the lead itself
    expect(rows('leadAttribution')).toHaveLength(0);
    expect(rows('signalEvent').some((e) => e.leadId)).toBe(false);
    expect(rows('signalSession').some((s) => s.leadId)).toBe(false);
    expect(rows('cmsLead')[0]).toMatchObject({ fields: null, erasedReason: 'subject_request' });
  });
});

describe('client allow-list', () => {
  it('"Where your leads come from": channels with AI assistants, no ids, visitor ids, city, payload or non-landing paths', async () => {
    await ingest([...chatgptSession(1, '2026-10-22'), ...chatgptSession(2, '2026-09-10', { leadId: null })]);
    await storeLead();
    await runSessionizer({ now: new Date('2026-10-22T16:05:00Z') });
    await attributeLeads({ now: new Date('2026-10-22T16:05:00Z') });
    await runRollup({ now: new Date('2026-10-23T03:30:00Z') });
    const view = await clientSignalsView(PROJECT, { now: new Date('2026-10-23T09:00:00Z') });
    expect(view.available).toBe(true);
    const ai = view.thisMonth.find((c) => c.id === 'ai');
    expect(ai).toMatchObject({ label: 'AI assistants', leads: 1 });
    expect(ai.sources[0]).toMatchObject({ label: 'ChatGPT', leads: 1 });
    expect(view.trend).toHaveLength(13);
    expect(view.notes.aiMode).toMatch(/AI Mode/);
    expect(view.recentLeads[0].lines[0]).toMatch(/^Came from ChatGPT → landed on \/spa-services\//);
    const body = JSON.stringify(view);
    expect(body).not.toMatch(/v_[0-9A-Z]{26}|s_[0-9A-Z]{26}|01JB3QLEAD/);
    expect(body).not.toMatch(/Waukesha|"city"|payload|ipHash|ipPrefix|"sessionId"|"visitorId"|"leadId"|"eventId"/);
    expect(body).not.toContain('/spa-services/hot-tub-repair/'); // a page that was not a landing page
    const csv = await clientDailyCsv('p1', { from: '2026-09-01', to: '2026-11-01' });
    expect(csv.split('\r\n')[0]).toBe('date,channel,refClass,refSource,sessions,visitorsThatDay,pageviews,engagedSessions,ctaClicks,formStarts,leads');
    expect(csv).not.toMatch(/v_[0-9A-Z]{26}|Waukesha/);
  });

  it('a WordPress project (no capability) gets { available: false } only', async () => {
    expect(await clientSignalsView({ id: 'p2', cmsType: 'WORDPRESS', cmsCapabilities: {} })).toEqual({ available: false });
    expect(await clientSignalsView({ id: 'p3', cmsType: 'EMDASH', cmsCapabilities: { signals: false } })).toEqual({ available: false });
  });

  it('staff explorer shows city and a short visitor hash (admin only)', async () => {
    await ingest(chatgptSession());
    await runSessionizer({ now: new Date('2026-10-22T16:05:00Z') });
    const list = await listSessions('p1', { from: '2026-10-01', to: '2026-11-01' });
    expect(list.items[0]).toMatchObject({ city: 'Waukesha', visitorHash: sha256(VISITOR).slice(0, 8), visitorId: VISITOR, hasLead: true });
  });
});

describe('Health v2 / site-metrics hooks', () => {
  it('leadsBySource, llmReferralSessions and fieldVitals (p75)', async () => {
    await ingest([...chatgptSession(1), sig('vitals', { at: '2026-10-22T14:06:31Z' })]);
    await storeLead();
    await runSessionizer({ now: new Date('2026-10-22T16:05:00Z') });
    await attributeLeads({ now: new Date('2026-10-22T16:05:00Z') });
    await runRollup({ now: new Date('2026-10-23T03:30:00Z') });
    expect((await leadsBySource('p1', '2026-10-01', '2026-11-01'))[0]).toMatchObject({ refClass: 'ai', refSource: 'chatgpt', leads: 1 });
    expect(await llmReferralSessions('p1', '2026-10-01', '2026-11-01')).toEqual({ sessions: 1, bySource: { chatgpt: 1 } });
    const v = await fieldVitals('p1', '2026-10-01', '2026-11-01');
    expect(v.samples).toBe(1);
    expect(v.lcpMs).toBe(TEMPLATES.vitals.vitals.lcpMs);
    expect(p75([1, 2, 3, 4])).toBe(3);
  });
});

describe('site snapshot only', () => {
  it('upsertSiteAttribution never runs for a lead without attribution or heard_from', async () => {
    await storeLead({ attribution: null });
    expect(rows('leadAttribution')).toHaveLength(0);
    expect(await upsertSiteAttribution({ id: rows('cmsLead')[0].id, projectId: 'p1', leadId: LEAD }, { attribution: null })).toBe('stale');
  });
});

// Every Prisma call made by the code under test must match the real schema (tests/helpers/prismaShape.js).
afterEach(() => expect(takeShapeViolations()).toEqual([]));
