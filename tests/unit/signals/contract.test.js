/**
 * Contract v1.7.0 §38 on the OS side, pure parts: the referrers.mjs port against vectors/referrers.json (97), the
 * redaction vectors' signal cases through the ingest path, strict validation + clamping of signalEvent, the payload
 * minus scalars, the lead attribution shapes, the config / summary sanitizers, the 1.7.0 examples.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, classifyReferrer, REFERRER_TABLE_VERSION, CLASSES } from '../../../src/lib/signals/referrers.js';
import {
  sanitizeSignal,
  sanitizeSignalsBatch,
  signalToRow,
  rowToSignal,
  sanitizeLeadAttributedData,
  sanitizeSignalsErasedData,
  sanitizeSignalsConfig,
  sanitizeSignalsConfigChanged,
  sanitizeSignalsSummary,
  validateSignalsEvent,
  REF_CLASSES,
  SIGNAL_LIMITS,
} from '../../../src/lib/signals/validate.js';
import { validateEvent } from '../../../src/routes/webhooks/emdash.js';
import { CONTRACT_REVISION, MAX_EVENTS_ROUTE_BODY_BYTES, MAX_EVENTS_BODY_BYTES } from '../../../src/lib/siteAdapters/signing.js';
import { MUTATION_ROUTES, emdashRoutes } from '../../../src/lib/siteAdapters/emdash.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (p) => JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract', p), 'utf8'));
const ex = (name) => fx(`examples/${name}.json`);

const batchEvent = () => ex('events.request--signals').events[0];
const visit = () => structuredClone(batchEvent().data.events[0]);

describe('contract revision and transport', () => {
  it('claims 1.7.0 or later (1.8.0 since §39), /events takes 1.5 MiB, the handshake keeps 1 MiB', () => {
    expect(CONTRACT_REVISION.localeCompare('1.7.0', undefined, { numeric: true })).toBeGreaterThanOrEqual(0);
    expect(MAX_EVENTS_ROUTE_BODY_BYTES).toBeGreaterThanOrEqual(1.5 * 1024 * 1024);
    expect(MAX_EVENTS_BODY_BYTES).toBe(1024 * 1024);
  });
  it('signals-config-set and signals-erase are mutations (idempotency key); the four routes exist', () => {
    expect(MUTATION_ROUTES.has('signals-config-set')).toBe(true);
    expect(MUTATION_ROUTES.has('signals-erase')).toBe(true);
    expect(MUTATION_ROUTES.has('signals-config-get')).toBe(false);
    for (const k of ['signalsConfigGet', 'signalsConfigSet', 'signalsSummary', 'signalsErase']) expect(typeof emdashRoutes[k]).toBe('function');
  });
});

describe('referrers.js port (vectors/referrers.json, §38.3)', () => {
  const v = fx('vectors/referrers.json');
  it('uses the same table version and the stable class enum', () => {
    expect(v.table).toBe(REFERRER_TABLE_VERSION);
    expect([...CLASSES]).toEqual([...REF_CLASSES]);
    expect(REF_CLASSES).toEqual(['ai', 'search', 'social', 'referral', 'direct', 'email', 'ads', 'internal', 'unknown']);
  });
  it(`passes all ${v.cases.length} vectors`, () => {
    expect(v.cases.length).toBe(97);
    for (const c of v.cases) {
      const r = classify({ referrerUrl: c.referrerUrl ?? null, landingUrl: c.landingUrl ?? null, siteHost: c.siteHost ?? v.siteHost, utm: c.utm ?? null, clickIds: c.clickIds ?? null });
      expect({ name: c.name, class: r.class, source: r.source }).toEqual({ name: c.name, ...c.expected });
    }
  });
  it('Google (AI Mode included) is search / google, never ai; the short form agrees', () => {
    expect(classifyReferrer('https://www.google.com/', null, null, { siteHost: 'oasispoolspas.com' })).toEqual({ class: 'search', source: 'google' });
    expect(classifyReferrer('https://chatgpt.com/', null, null, { siteHost: 'oasispoolspas.com' })).toEqual({ class: 'ai', source: 'chatgpt' });
  });
});

describe('signalEvent: strict validation, clamping, redaction (§38.4, §38.6, §38.8)', () => {
  it('accepts every signal of the example batch unchanged in meaning', () => {
    const ev = batchEvent();
    const r = sanitizeSignalsBatch(ev.data, { siteId: 'site_9f3c2a7b41d0' });
    expect(r.error).toBeUndefined();
    expect(r.invalid).toBe(0);
    expect(r.signals.map((s) => s.type)).toEqual(ev.data.events.map((e) => e.type));
    expect(r.signals[0].network.ipPrefix).toBe('203.0.113');
    expect(r.signals[0].network.ipHash).toBe('9f3a0c71d41d8cd9');
  });

  it('drops structurally invalid signals and keeps the rest (counted)', () => {
    const ok = visit();
    const badId = { ...visit(), eventId: 'not-a-ulid' };
    const missingDevice = { ...visit(), eventId: '01JB3Q7Z9F8K2M4N6P8R0T2V5A', device: null };
    const sessionOnlyWithVisitor = { ...visit(), eventId: '01JB3Q7Z9F8K2M4N6P8R0T2V5B', consent: { analytics: false, source: 'gpc' } };
    const missingKey = { ...visit(), eventId: '01JB3Q7Z9F8K2M4N6P8R0T2V5C' };
    delete missingKey.cta;
    const otherSite = { ...visit(), eventId: '01JB3Q7Z9F8K2M4N6P8R0T2V5D', siteId: 'site_other000001' };
    const r = sanitizeSignalsBatch({ batchId: '01JB3QBATCH00000000000000B', table: '1.0.0', count: 6, events: [ok, badId, missingDevice, sessionOnlyWithVisitor, missingKey, otherSite] }, { siteId: 'site_9f3c2a7b41d0' });
    expect(r.signals).toHaveLength(1);
    expect(r.invalid).toBe(5);
  });

  it('clamps over-long text, drops non-allow-listed query keys and extra bot reasons, strips the referrer query', () => {
    const e = visit();
    e.page.title = 'T'.repeat(500);
    e.page.query = { utm_source: 'chatgpt.com', email: 'x@y.z', q: 'secret search' };
    e.referrer.url = 'https://chatgpt.com/?q=private';
    e.bot.reason = ['ua_bot', 'rate', 'bogus'];
    e.tzOffset = 9999;
    const ctx = { clamped: 0 };
    const { signal } = sanitizeSignal(e, { ctx });
    expect(signal.page.title).toHaveLength(SIGNAL_LIMITS.title);
    expect(signal.page.query).toEqual({ utm_source: 'chatgpt.com' });
    expect(signal.referrer.url).toBe('https://chatgpt.com/');
    expect(signal.bot.reason).toEqual(['ua_bot', 'rate']);
    expect(signal.tzOffset).toBeNull();
    expect(ctx.clamped).toBeGreaterThanOrEqual(4);
  });

  it('redacts every string (redact.json signal cases): e-mail in utm_content, phone in a title, dotted quad; ipPrefix / ipHash survive', () => {
    const red = fx('vectors/redact.json');
    const e = visit();
    e.utm.content = 'promo for bob.smith@example.com';
    e.page.title = 'Call (414) 555-0123 today';
    e.page.canonical = 'https://oasispoolspas.com/x?from=10.1.2.3';
    const { signal } = sanitizeSignal(e);
    expect(signal.utm.content).toBe('promo for [email]');
    expect(signal.page.title).toBe('Call [phone] today');
    expect(signal.page.canonical).toContain('[ip]');
    expect(signal.network.ipPrefix).toBe('203.0.113');
    expect(signal.network.ipHash).toBe('9f3a0c71d41d8cd9');
    // the vector file itself carries the v1.7.0 cases
    expect(JSON.stringify(red)).toMatch(/ipPrefix|ipHash/);
  });

  it('payload = envelope minus the indexed scalars; rowToSignal re-assembles it', () => {
    const { signal } = sanitizeSignal(visit());
    const row = signalToRow('p1', signal);
    expect(row).toMatchObject({ projectId: 'p1', eventId: signal.eventId, type: 'visit', sessionId: signal.sessionId, visitorId: signal.visitorId, refClass: 'ai', refSource: 'chatgpt', country: 'US', pagePath: '/spa-services/', botScore: 5, leadId: null });
    for (const k of ['eventId', 'type', 'ts', 'sessionId', 'visitorId', 'siteId']) expect(row.payload).not.toHaveProperty(k);
    expect(row.payload.page).not.toHaveProperty('path');
    expect(row.payload.network).not.toHaveProperty('country');
    expect(row.payload.referrer).not.toHaveProperty('class');
    expect(row.payload.bot).toEqual({ reason: [] });
    const back = rowToSignal({ ...row, at: row.at });
    expect(back.page.path).toBe('/spa-services/');
    expect(back.network.country).toBe('US');
    expect(back.referrer).toMatchObject({ class: 'ai', source: 'chatgpt', url: 'https://chatgpt.com/' });
    expect(JSON.stringify(back)).not.toContain('"id"');
  });

  it('envelope checks: signals.batch needs a batchId and ≤ 100 signals; never lead / snapshotText', () => {
    expect(validateEvent(batchEvent())).toBeNull();
    expect(validateSignalsEvent({ ...batchEvent(), data: { ...batchEvent().data, batchId: 'x' } })).toMatch(/batchId/);
    expect(validateSignalsEvent({ ...batchEvent(), data: { ...batchEvent().data, events: new Array(101).fill({}) } })).toMatch(/at most 100/);
    expect(validateSignalsEvent({ ...batchEvent(), snapshotText: 'x' })).toMatch(/snapshotText/);
    for (const e of ex('events.request--signals').events) expect(validateEvent(e)).toBeNull();
    for (const e of ex('events.request--lead-attribution').events) expect(validateEvent(e)).toBeNull();
  });
});

describe('lead attribution, erasure, settings and summary shapes', () => {
  it('lead.attributed data is sanitized and redacted; a bad attribution is refused', () => {
    const ev = ex('events.request--signals').events.find((e) => e.type === 'lead.attributed');
    const { data } = sanitizeLeadAttributedData(ev.data);
    expect(data.leadId).toBe(ev.data.leadId);
    expect(data.attribution.lastTouch).toMatchObject({ class: expect.any(String), source: expect.any(String) });
    expect(sanitizeLeadAttributedData({ ...ev.data, attribution: { model: 'magic' } }).error).toMatch(/attribution/);
  });
  it('signals.erased carries a hash only', () => {
    const ev = ex('events.request--signals').events.find((e) => e.type === 'signals.erased');
    const { data } = sanitizeSignalsErasedData(ev.data);
    expect(data.subjectHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sanitizeSignalsErasedData({ ...ev.data, subjectHash: 'v_01JB2R1S3T5V7X9Z1B3D5F7H9K' }).error).toBeTruthy();
  });
  it('config, config_changed and summary sanitizers accept the examples', () => {
    const cfg = sanitizeSignalsConfig(ex('signals-config-get.response').config);
    expect(cfg).toMatchObject({ schemaVersion: 1, events: { visit: true, pageview: true } });
    const changed = ex('events.request--signals').events.filter((e) => e.type === 'signals.config_changed');
    for (const c of changed) expect(sanitizeSignalsConfigChanged(c.data).data.changes.length).toBeGreaterThan(0);
    const sum = sanitizeSignalsSummary(ex('signals-summary.response'));
    expect(sum).toMatchObject({ hours: 24, accepted: 612, botShare: 0.112, rejected: { editor: 41 } });
  });
});
