/**
 * Embedded GoHighLevel forms + EmDash contract 1.9.0 on the OS side (features/ghl-forms.md), against the in-memory
 * Prisma stand-in (every call shape-checked against the generated client, tests/helpers/prismaShape.js):
 * webhook token lookup (404 unknown / revoked, rotation overlap, header secret), body cap, rate limit, replay cache,
 * normaliser (pinned body + GHL default payload, heardFrom), notifications once, provider dimension, attribution
 * (oa_sid, GHL field values, ±10 min form_submit window + mismatch), unmatched counter, form_submit ingest,
 * lead.attributed externalRef, lead-import (schema, idempotency key, backoff, every error code, no double lead),
 * the Integrations API (token once, rotate, revoke, HUMAN_ONLY), erasure checklist, Health L1 counting.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { takeShapeViolations } from '../../helpers/prismaShape.js';
import { validateAgainst } from '../../helpers/miniSchema.js';

vi.mock('../../../src/lib/prisma.js', async () => {
  const { createFakePrisma } = await import('../signals/fakePrisma.js');
  return { prisma: createFakePrisma() };
});
const spies = vi.hoisted(() => ({ notify: [], publish: [], site: { handler: null, calls: [] } }));
vi.mock('../../../src/lib/notificationService.js', () => ({ notify: async (args) => spies.notify.push(args) }));
vi.mock('../../../src/lib/realtimeBus.js', () => ({ publish: (...args) => spies.publish.push(args), subscribe: () => {}, subscriberCount: () => 0 }));
vi.mock('../../../src/lib/cmsStore.js', async (orig) => ({
  ...(await orig()),
  loadEmdashConnection: async () => ({ conn: { siteId: 'site_9f3c2a7b41d0', siteUrl: 'https://oasispoolspas.com' } }),
}));
vi.mock('../../../src/lib/siteAdapters/emdash.js', async (orig) => {
  const o = await orig();
  const call = (route) => async (_c, body, opts) => {
    spies.site.calls.push({ route, body, opts });
    return spies.site.handler(route, body, opts);
  };
  return { ...o, emdashRoutes: { ...o.emdashRoutes, leadImport: call('lead-import'), leadErase: call('lead-erase') } };
});

import { prisma } from '../../../src/lib/prisma.js';
import { normalizeGhlForm, val, ghlContactUrl, touchFromGhlFields } from '../../../src/lib/ghlForms/normalize.js';
import { generateEndpoint, rotateEndpoint, revokeEndpoint, setHeaderSecret, findEndpointByToken, headerSecretOk, webhookSetup, hashToken, ROTATION_OVERLAP_MS } from '../../../src/lib/ghlForms/endpoints.js';
import { receiveGhlForm, ulid } from '../../../src/lib/ghlForms/receive.js';
import { ghlFormsWebhookRoutes, createTokenLimiter, GHL_BODY_LIMIT } from '../../../src/routes/webhooks/ghlForms.js';
import { pmGhlFormsRoutes } from '../../../src/routes/pm/ghlForms.js';
import { pmCmsLeadsReportsRoutes } from '../../../src/routes/pm/cmsLeadsReports.js';
import { buildLeadImportBody, leadImportIdempotencyKey, runLeadImportQueue, sendLeadImport, classifyLeadImportError, LEAD_IMPORT_RETRY_DELAYS_MS, LEAD_IMPORT_MAX_ATTEMPTS, systemActor } from '../../../src/lib/ghlForms/leadImport.js';
import { purgeExternalFormReceipts } from '../../../src/lib/ghlForms/jobs.js';
import { ingestSignalsBatch } from '../../../src/lib/signals/ingest.js';
import { runSessionizer, mergeSessionLeadIds } from '../../../src/lib/signals/sessionize.js';
import { attributeLeads, applyLeadAttributed, attributionSentence, staffAttribution } from '../../../src/lib/signals/attribution.js';
import { sanitizeSignal, SIGNAL_TYPES } from '../../../src/lib/signals/validate.js';
import { unmatchedFormSubmits, leadsByProvider } from '../../../src/lib/signals/metrics.js';
import { dataQuality, clientSignalsView, staffOverview } from '../../../src/lib/signals/views.js';
import { applyLeadEvent, eraseLead, confirmExternalErase } from '../../../src/lib/cmsLeads.js';
import { bumpBreakdowns } from '../../../src/lib/leadSideEffects.js';
import { sanitizeLeadForm } from '../../../src/lib/cmsStore.js';
import { CmsBridgeError } from '../../../src/lib/siteAdapters/emdash.js';
import { CONTRACT_REVISION } from '../../../src/lib/siteAdapters/signing.js';
import { redactSensitiveUrl } from '../../../src/lib/logRedaction.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ex = (name) => JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract/examples', `${name}.json`), 'utf8'));
const rows = (name) => prisma._rows(name);
const SITE = 'site_9f3c2a7b41d0';
const SID = 's_01JB3Q7Z9F8K2M4N6P8R0T2V00';
const VID = 'v_01JB2R1S3T5V7X9Z1B3D5F7H9K';
const SITE_INFO = ex('site-info.response--lead-import');
const PROJECT = { id: 'p1', name: 'Oasis Pools', clientId: 'c1', leadPmId: '11111111-1111-4111-8111-111111111111', cmsType: 'EMDASH', cmsSiteId: SITE, cmsCapabilities: { signals: true, leadImport: true }, cmsHealth: { leads: { forms: SITE_INFO.leads.forms.map(sanitizeLeadForm) } }, cmsRepairNeededAt: null, wpUrl: 'https://oasispoolspas.com', status: 'ACTIVE', client: { leadPmId: '22222222-2222-4222-8222-222222222222', secondaryPmId: null } };
const OWNER = { id: '0f1e2d3c-4b5a-4968-8776-655443322110', name: 'Sam Owner', role: 'OWNER' };

/** The pinned body of the inbox note with GHL's merge fields resolved. */
function pinned(over = {}) {
  const b = {
    v: 1,
    provider: 'ghl',
    event: 'form_submitted',
    form: { id: '4KKSBxHdlE5qWEtsdlCQ', name: 'Oasis Contact Form' },
    contact: { id: 'pXy7Qe3LmN0aB1cD2eF3', createdAt: '2026-10-22T14:08:00Z' },
    location: { id: 'LoC4tIoN0000000000' },
    fields: { name: 'Pat Example', firstName: 'Pat', lastName: 'Example', email: 'pat@example.com', phone: '+1 262 555 0100', city: 'Waukesha', state: 'WI', postalCode: '53186', message: 'Please quote a winter closing.', source: 'website-embed', heardFrom: 'AI assistant (ChatGPT, Perplexity…)' },
    attribution: { oa_sid: SID, oa_vid: VID, ref_class: 'ai', ai_source: 'chatgpt', source: 'chatgpt', campaign: '{{contact.oa_campaign}}', landing: '/spa-services/', page: '/contact/?email=pat@example.com', utm: { source: '{{contact.utm_source}}', medium: '', campaign: '', term: '', content: '' } },
    workflow: { id: 'wf1', name: 'Website form → Agency OS' },
  };
  return { ...b, ...over, fields: { ...b.fields, ...(over.fields || {}) }, attribution: { ...b.attribution, ...(over.attribution || {}) }, contact: { ...b.contact, ...(over.contact || {}) } };
}

/** GHL's default "Webhook" action payload (contact fields at the root, custom fields under customData). */
function defaultPayload(over = {}) {
  return {
    contact_id: 'dEfAuLt0000000000001',
    first_name: 'Lee',
    last_name: 'Default',
    full_name: 'Lee Default',
    email: 'lee@example.com',
    phone: '+1 262 555 0199',
    city: 'Brookfield',
    state: 'WI',
    postal_code: '53045',
    contact_source: 'website-embed',
    date_created: '2026-10-22T15:00:00.000Z',
    location: { id: 'LoC4tIoN0000000000', name: 'Oasis' },
    workflow: { id: 'wf2', name: 'Default webhook' },
    customData: { 'How did you hear about us?': 'Google', oa_sid: '{{contact.oa_sid}}', oa_ref_class: 'search', oa_source: 'google', utm_source: 'google', utm_medium: 'organic', message: 'Hot tub repair please' },
    ...over,
  };
}

let n = 0;
const nid = () => `01JB3Q${String((n += 1)).padStart(20, '0')}`;
const SIG = Object.fromEntries(ex('events.request--signals').events[0].data.events.reverse().map((e) => [e.type, e]));
const FORM_SUBMIT = ex('events.request--form-submit').events[0].data.events[0];
function sig(type, { at, sessionId = SID, visitorId = VID, formId } = {}) {
  const s = structuredClone(type === 'form_submit' ? FORM_SUBMIT : SIG[type]);
  s.eventId = nid();
  s.sessionId = sessionId;
  s.visitorId = visitorId;
  s.consent = visitorId ? { analytics: true, source: 'default-us' } : { analytics: false, source: 'gpc' };
  if (!visitorId && s.network) s.network.ipHash = null;
  if (at) s.ts = new Date(at).toISOString();
  if (formId && s.lead) s.lead.formId = formId;
  return s;
}
const ingest = (signals) => ingestSignalsBatch(PROJECT, { type: 'signals.batch', eventId: nid(), data: { batchId: nid(), table: '1.0.0', count: signals.length, events: signals } }, { now: new Date('2026-10-22T16:00:00Z') });

beforeEach(() => {
  prisma._reset();
  spies.notify.length = 0;
  spies.publish.length = 0;
  spies.site.calls = [];
  spies.site.handler = async () => ({ ok: true, leadId: '01JB3QMIRROR00000000000001', created: true, attribution: null });
  rows('project').push(structuredClone(PROJECT));
  rows('user').push({ id: OWNER.id, role: 'OWNER', isAgent: false, createdAt: new Date('2020-01-01') });
});
afterEach(() => {
  expect(takeShapeViolations()).toEqual([]);
});

/* ───────────────────────────── normaliser ───────────────────────────── */

describe('normalizeGhlForm', () => {
  it('pinned body: fields, town, heardFrom → extra.heard_from, attribution ids / classes, merge tags empty, page query dropped', () => {
    const { lead } = normalizeGhlForm(pinned());
    expect(lead.shape).toBe('pinned');
    expect(lead.form).toEqual({ id: '4KKSBxHdlE5qWEtsdlCQ', name: 'Oasis Contact Form' });
    expect(lead.contactId).toBe('pXy7Qe3LmN0aB1cD2eF3');
    expect(lead.fields).toMatchObject({ name: 'Pat Example', email: 'pat@example.com', phone: '+1 262 555 0100', town: 'Waukesha, WI', postalCode: '53186', message: 'Please quote a winter closing.' });
    expect(lead.fields.extra).toEqual({ source: 'website-embed', oa_page: '/contact/', heard_from: 'AI assistant (ChatGPT, Perplexity…)' });
    expect(lead.heardFrom).toBe('AI assistant (ChatGPT, Perplexity…)');
    expect(lead.attribution).toMatchObject({ sessionId: SID, visitorId: VID, refClass: 'ai', aiSource: 'chatgpt', campaign: null, landing: '/spa-services/', page: '/contact/', utm: null });
    expect(lead.createdAt.toISOString()).toBe('2026-10-22T14:08:00.000Z');
    expect(lead.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(normalizeGhlForm(pinned()).lead.payloadHash).toBe(lead.payloadHash);
    expect(normalizeGhlForm(pinned({ fields: { message: 'changed' } })).lead.payloadHash).not.toBe(lead.payloadHash);
  });

  it('GHL default payload: root contact fields, customData by key and by label (heard from), utm-derived class', () => {
    const { lead } = normalizeGhlForm(defaultPayload());
    expect(lead.shape).toBe('default');
    expect(lead.contactId).toBe('dEfAuLt0000000000001');
    expect(lead.fields).toMatchObject({ name: 'Lee Default', email: 'lee@example.com', town: 'Brookfield, WI', postalCode: '53045', message: 'Hot tub repair please' });
    expect(lead.heardFrom).toBe('Google');
    expect(lead.fields.extra.heard_from).toBe('Google');
    expect(lead.attribution.sessionId).toBeNull(); // unresolved merge tag
    expect(lead.attribution).toMatchObject({ refClass: 'search', source: 'google', utm: { source: 'google', medium: 'organic', campaign: null, term: null, content: null } });
    expect(lead.locationId).toBe('LoC4tIoN0000000000');
  });

  it('rejects unknown shapes and empty submissions with fixed, value-free reasons; bad ids / classes / paths are dropped', () => {
    expect(normalizeGhlForm({ hello: 'world' })).toEqual({ error: 'unknown_shape' });
    expect(normalizeGhlForm(null)).toEqual({ error: 'unknown_shape' });
    const empty = pinned();
    empty.fields = { name: '{{contact.name}}', email: '{{contact.email}}', phone: '', message: '{{contact.message}}' };
    expect(normalizeGhlForm(empty)).toEqual({ error: 'empty' });
    const { lead } = normalizeGhlForm(pinned({ attribution: { oa_sid: 's_short', oa_vid: 'v_bad', ref_class: 'internal', landing: '//evil.example/x', page: 'https://x.example/' } }));
    expect(lead.attribution).toMatchObject({ sessionId: null, visitorId: null, refClass: null, aiSource: null, landing: null, page: null });
    expect(val('{{ contact.x }}')).toBe('');
    expect(val('  ok\u0007 ')).toBe('ok');
  });

  it('cuts every field to its bound and builds the staff contact link only from valid ids', () => {
    const { lead } = normalizeGhlForm(pinned({ fields: { message: 'x'.repeat(5000), name: 'n'.repeat(500) } }));
    expect(lead.fields.message).toHaveLength(2000);
    expect(lead.fields.name).toHaveLength(200);
    expect(ghlContactUrl('LoC4tIoN0000000000', 'pXy7Qe3LmN0aB1cD2eF3', { GHL_APP_HOST: 'list.localwavesmarketing.com' })).toBe('https://list.localwavesmarketing.com/v2/location/LoC4tIoN0000000000/contacts/detail/pXy7Qe3LmN0aB1cD2eF3');
    expect(ghlContactUrl('LoC', 'a/b', {})).toBeNull();
    expect(ghlContactUrl('LoC4', 'c1', { GHL_APP_HOST: 'evil host/' })).toBe('https://app.gohighlevel.com/v2/location/LoC4/contacts/detail/c1');
    expect(touchFromGhlFields({ refClass: null, utm: { source: 'google', medium: 'cpc' } }, '2026-10-22T00:00:00Z')).toMatchObject({ class: 'ads', source: 'google', medium: 'cpc' });
    expect(touchFromGhlFields({ refClass: null, utm: null }, '2026-10-22T00:00:00Z')).toBeNull();
  });
});

/* ───────────────────────────── endpoint credential ───────────────────────────── */

describe('webhook token: lookup, rotation overlap, revoke, header secret', () => {
  it('unknown → null, the current token → current, after rotate the old one works 24 h then not, revoked → null', async () => {
    const t0 = new Date('2026-10-23T10:00:00Z');
    const { token } = await generateEndpoint('p1', OWNER, { now: t0 });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rows('externalFormEndpoint')[0].tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(rows('externalFormEndpoint'))).not.toContain(token);
    expect(await findEndpointByToken('x'.repeat(43))).toBeNull();
    expect(await findEndpointByToken('short')).toBeNull();
    expect((await findEndpointByToken(token, { now: t0 })).matched).toBe('current');
    await expect(generateEndpoint('p1', OWNER)).rejects.toMatchObject({ status: 409 });
    const { token: t2 } = await rotateEndpoint('p1', { now: t0 });
    expect((await findEndpointByToken(t2, { now: t0 })).matched).toBe('current');
    expect((await findEndpointByToken(token, { now: new Date(t0.getTime() + ROTATION_OVERLAP_MS - 1000) })).matched).toBe('previous');
    expect(await findEndpointByToken(token, { now: new Date(t0.getTime() + ROTATION_OVERLAP_MS + 1000) })).toBeNull();
    await revokeEndpoint('p1', { now: t0 });
    expect(await findEndpointByToken(t2, { now: t0 })).toBeNull();
    expect(await findEndpointByToken(token, { now: t0 })).toBeNull();
    const { token: t3 } = await generateEndpoint('p1', OWNER);
    expect((await findEndpointByToken(t3)).matched).toBe('current');
  });

  it('header secret: none configured passes; configured must match in constant time; clear removes it', async () => {
    await generateEndpoint('p1', OWNER);
    const ep = () => rows('externalFormEndpoint')[0];
    expect(headerSecretOk(ep(), undefined)).toBe(true);
    const { secret } = await setHeaderSecret('p1');
    expect(secret).toBeTruthy();
    expect(headerSecretOk(ep(), secret)).toBe(true);
    expect(headerSecretOk(ep(), `${secret}x`)).toBe(false);
    expect(headerSecretOk(ep(), undefined)).toBe(false);
    await setHeaderSecret('p1', { clear: true });
    expect(headerSecretOk(ep(), 'anything')).toBe(true);
  });

  it('the copy-paste block: URL with the token, the secret header, and the pinned body with GHL merge fields incl. heard_from', () => {
    const s = webhookSetup({ baseUrl: 'https://account.localwaves.ai/', token: 'T'.repeat(43), secret: 'sec', form: { id: '4KKSBxHdlE5qWEtsdlCQ', name: 'Oasis Contact Form' } });
    expect(s.url).toBe(`https://account.localwaves.ai/api/webhooks/ghl/forms/${'T'.repeat(43)}`);
    expect(s.headers).toEqual([{ name: 'Content-Type', value: 'application/json' }, { name: 'X-OS-Webhook-Secret', value: 'sec' }]);
    const body = JSON.parse(s.body);
    expect(body).toMatchObject({ v: 1, provider: 'ghl', event: 'form_submitted', contact: { id: '{{contact.id}}' }, fields: { heardFrom: '{{contact.heard_from}}' }, attribution: { oa_sid: '{{contact.oa_sid}}', utm: { source: '{{contact.utm_source}}' } } });
    expect(normalizeGhlForm(body)).toEqual({ error: 'empty' }); // an untested template never creates a lead
    expect(webhookSetup({ baseUrl: 'https://x' }).url).toContain('<projectToken>');
    expect(redactSensitiveUrl(`/api/webhooks/ghl/forms/${'T'.repeat(43)}`)).toBe('/api/webhooks/ghl/forms/[redacted]');
  });
});

/* ───────────────────────────── webhook route ───────────────────────────── */

describe('POST /api/webhooks/ghl/forms/:projectToken', () => {
  let app;
  let limiter;
  beforeAll(async () => {
    app = Fastify();
    limiter = { max: 1000, hit: null };
    const real = () => createTokenLimiter({ max: limiter.max });
    let inner = real();
    limiter.reset = () => (inner = real());
    await app.register(ghlFormsWebhookRoutes, { prefix: '/api/webhooks/ghl', limiter: { hit: (k) => inner.hit(k) } });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    limiter.max = 1000;
    limiter.reset();
  });
  const post = (token, payload, headers = {}) => app.inject({ method: 'POST', url: `/api/webhooks/ghl/forms/${token}`, payload, headers });

  it('unknown or revoked token → 404 (no enumeration), nothing stored', async () => {
    expect((await post('A'.repeat(43), pinned())).statusCode).toBe(404);
    expect((await post('nope', pinned())).statusCode).toBe(404);
    const { token } = await generateEndpoint('p1', OWNER);
    await revokeEndpoint('p1');
    const res = await post(token, pinned());
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(rows('cmsLead')).toHaveLength(0);
  });

  it('header secret mismatch → 404 with a rejected receipt; the right secret → 200', async () => {
    const { token } = await generateEndpoint('p1', OWNER);
    const { secret } = await setHeaderSecret('p1');
    expect((await post(token, pinned())).statusCode).toBe(404);
    expect((await post(token, pinned(), { 'x-os-webhook-secret': 'wrong' })).statusCode).toBe(404);
    expect(rows('externalFormReceipt').map((r) => r.reason)).toEqual(['header_secret', 'header_secret']);
    expect((await post(token, pinned(), { 'x-os-webhook-secret': secret })).statusCode).toBe(200);
  });

  it('a new lead: 200 { leadId: xg_… }, CmsLead provider ghl with the PII block, attribution, metrics, ONE notification, mirror queued', async () => {
    const { token } = await generateEndpoint('p1', OWNER);
    const res = await post(token, pinned());
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, duplicate: false });
    expect(body.leadId).toMatch(/^xg_[0-9A-HJKMNP-TV-Z]{26}$/);
    const [lead] = rows('cmsLead');
    expect(lead).toMatchObject({ leadId: body.leadId, provider: 'ghl', formId: 'ghl-contact', externalId: 'pXy7Qe3LmN0aB1cD2eF3', sourcePath: '/contact/', mirrorState: 'pending', spamVerdict: 'ok' });
    expect(lead.externalUrl).toMatch(/\/v2\/location\/LoC4tIoN0000000000\/contacts\/detail\/pXy7Qe3LmN0aB1cD2eF3$/);
    expect(lead.fields.extra.heard_from).toBe('AI assistant (ChatGPT, Perplexity…)');
    const [attr] = rows('leadAttribution');
    expect(attr).toMatchObject({ siteLeadId: body.leadId, sessionId: SID, visitorId: VID, formId: 'ghl-contact', placement: 'embedded_form', heardFrom: 'AI assistant (ChatGPT, Perplexity…)', lastClass: 'ai', lastSource: 'chatgpt', model: 'cookie-only' });
    expect(attr.siteSnapshot.origin).toBe('ghl-fields');
    const [metric] = rows('siteLeadDailyMetric');
    expect(metric).toMatchObject({ leads: 1, formSubmits: 1 });
    expect(metric.breakdowns.providers).toEqual([{ provider: 'ghl', label: 'GoHighLevel form', count: 1 }]);
    expect(metric.breakdowns.rules[0].ruleId).toBe('ghl:ghl-contact');
    expect(spies.notify).toHaveLength(1);
    expect(spies.notify[0]).toMatchObject({ slug: 'lead_received', recipientIds: [PROJECT.leadPmId, PROJECT.client.leadPmId], variables: { formLabel: 'GoHighLevel form' } });
    expect(JSON.stringify(spies.notify[0])).not.toMatch(/Pat|example\.com|555/);
    expect(spies.publish).toEqual([['p1', 'lead.created', { leadId: body.leadId, provider: 'ghl' }]]);
    expect(rows('externalFormReceipt')[0]).toMatchObject({ status: 'accepted', reason: 'ok', shape: 'pinned', leadId: body.leadId });
    expect(JSON.stringify(rows('externalFormReceipt'))).not.toMatch(/Pat|example\.com|555/);
    expect(rows('externalFormEndpoint')[0].lastReceivedAt).toBeInstanceOf(Date);
  });

  it('replay: the same delivery again → 200 { duplicate: true } with the first leadId; no second lead, no second notification', async () => {
    const { token } = await generateEndpoint('p1', OWNER);
    const first = (await post(token, pinned())).json();
    const again = await post(token, pinned());
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ ok: true, duplicate: true, leadId: first.leadId });
    expect(rows('cmsLead')).toHaveLength(1);
    expect(spies.notify).toHaveLength(1);
    expect(rows('siteLeadDailyMetric')[0].leads).toBe(1);
    expect(rows('externalFormReceipt').map((r) => r.status)).toEqual(['accepted', 'duplicate']);
  });

  it('an edited re-submit (same contact and form, different values, within 10 min) is a second lead linked by duplicateOf', async () => {
    const { token } = await generateEndpoint('p1', OWNER);
    const first = (await post(token, pinned())).json();
    const second = (await post(token, pinned({ fields: { message: 'Also a spa cover.' } }))).json();
    expect(second.duplicate).toBe(false);
    expect(second.leadId).not.toBe(first.leadId);
    expect(rows('externalFormReceipt')[1]).toMatchObject({ reason: 'resubmit', duplicateOf: first.leadId });
    expect(spies.notify).toHaveLength(2);
  });

  it('a concurrent replay losing the unique claim is answered as a duplicate (PM2-safe)', async () => {
    const ep = (await generateEndpoint('p1', OWNER)).endpoint;
    const at = new Date('2026-10-23T12:00:00Z');
    const a = await receiveGhlForm({ project: PROJECT, endpoint: ep, body: pinned(), now: at });
    // the look-back query misses (e.g. the other instance has not committed yet): the dedupeKey unique index decides
    const db = new Proxy(prisma, { get: (t, p) => (p === 'externalFormReceipt' ? { ...t.externalFormReceipt, findFirst: async () => null } : t[p]) });
    const b = await receiveGhlForm({ project: PROJECT, endpoint: ep, body: pinned(), now: at, db });
    expect(b.body).toEqual({ ok: true, duplicate: true, leadId: a.body.leadId });
    expect(rows('cmsLead')).toHaveLength(1);
  });

  it('GHL default payload as form-urlencoded and as JSON; unknown / empty bodies → 422 with a value-free reason', async () => {
    const { token } = await generateEndpoint('p1', OWNER);
    const flat = defaultPayload();
    delete flat.customData;
    delete flat.location;
    delete flat.workflow;
    const form = new URLSearchParams({ ...flat, heard_from: 'Friend or neighbor' }).toString();
    const r1 = await post(token, form, { 'content-type': 'application/x-www-form-urlencoded' });
    expect(r1.statusCode).toBe(200);
    expect(rows('cmsLead')[0].fields.extra.heard_from).toBe('Friend or neighbor');
    const r2 = await post(token, defaultPayload({ contact_id: 'dEfAuLt0000000000002' }));
    expect(r2.statusCode).toBe(200);
    const r3 = await post(token, { something: 'else' });
    expect(r3.statusCode).toBe(422);
    expect(r3.json()).toEqual({ ok: false, code: 'UNPROCESSABLE', reason: 'unknown_shape' });
    expect(rows('externalFormReceipt').filter((r) => r.status === 'rejected').map((r) => r.reason)).toEqual(['unknown_shape']);
  });

  it('body cap 64 KiB (413), unsupported type (415), broken JSON (400): receipts only, no lead, no echo', async () => {
    const { token } = await generateEndpoint('p1', OWNER);
    const big = pinned({ fields: { message: 'x'.repeat(GHL_BODY_LIMIT) } });
    const r1 = await post(token, big);
    expect(r1.statusCode).toBe(413);
    expect(r1.json()).toEqual({ ok: false, code: 'PAYLOAD_TOO_LARGE' });
    const r2 = await post(token, 'hello', { 'content-type': 'text/plain' });
    expect(r2.statusCode).toBe(415);
    const r3 = await post(token, '{"v":1,', { 'content-type': 'application/json' });
    expect(r3.statusCode).toBe(400);
    expect(r3.body).not.toContain('"v":1');
    expect(rows('cmsLead')).toHaveLength(0);
    expect(rows('externalFormReceipt').map((r) => r.reason)).toEqual(['too_large', 'unsupported_type', 'invalid_body']);
  });

  it('rate limit: 60 / min per token by default; over the limit → 429 + Retry-After before the body is read', async () => {
    limiter.max = 2;
    limiter.reset();
    const { token } = await generateEndpoint('p1', OWNER);
    expect((await post(token, pinned())).statusCode).toBe(200);
    expect((await post(token, pinned({ contact: { id: 'second0000000000000' } }))).statusCode).toBe(200);
    const r = await post(token, pinned({ contact: { id: 'third00000000000000' } }));
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(rows('cmsLead')).toHaveLength(2);
    const lim = createTokenLimiter({ max: 60, now: () => 0 });
    for (let i = 0; i < 60; i += 1) expect(lim.hit('a').ok).toBe(true);
    expect(lim.hit('a')).toEqual({ ok: false, retryAfterSec: 60 });
    expect(lim.hit('b').ok).toBe(true);
  });

  it('a site without capabilities.leadImport: the lead is stored, the mirror is skipped (NO_CAPABILITY)', async () => {
    rows('project')[0].cmsCapabilities = { signals: true };
    const { token } = await generateEndpoint('p1', OWNER);
    expect((await post(token, pinned())).statusCode).toBe(200);
    expect(rows('cmsLead')[0]).toMatchObject({ mirrorState: 'skipped', mirrorError: 'NO_CAPABILITY' });
  });
});

/* ───────────────────────────── attribution ───────────────────────────── */

describe('attribution of a GHL lead', () => {
  const ep = { id: 'ep1' };
  it('joins SignalSession by oa_sid (session arriving after the lead): os-derived "Came from ChatGPT → … → contact form"', async () => {
    const { body } = await receiveGhlForm({ project: PROJECT, endpoint: ep, body: pinned({ attribution: { ref_class: '', ai_source: '', source: '' } }), now: new Date('2026-10-22T14:08:05Z') });
    expect(rows('leadAttribution')[0]).toMatchObject({ sessionId: SID, lastClass: 'unknown', siteSnapshot: expect.objectContaining({ origin: 'ghl' }) });
    await attributeLeads(); // no session yet: nothing to derive
    expect(rows('leadAttribution')[0].model).toBe('cookie-only');
    await ingest([sig('visit', { at: '2026-10-22T14:03:11Z' }), sig('pageview', { at: '2026-10-22T14:03:11Z' }), sig('form_submit', { at: '2026-10-22T14:08:00Z' })]);
    await runSessionizer({ now: new Date('2026-10-22T16:00:00Z') });
    expect(rows('leadAttribution')[0].needsDerive).toBe(true); // flagged by the session (no lead event names the GHL lead)
    await attributeLeads({ now: new Date('2026-10-22T16:01:00Z') });
    const a = rows('leadAttribution')[0];
    expect(a).toMatchObject({ model: 'os-derived', lastClass: 'ai', lastSource: 'chatgpt', mismatch: false });
    expect(attributionSentence(a)[0]).toMatch(/^Came from ChatGPT → landed on .* → contact form \(embedded form\)$/);
    const s = rows('signalSession').find((x) => x.sessionId === SID);
    expect(s).toMatchObject({ leadId: body.leadId, leadCount: 1, formSubmits: 1 });
    expect(staffAttribution(a)).toMatchObject({ provider: 'ghl', match: 'session' });
    // a rebuild keeps the link (the attribution names the session)
    await ingest([sig('engagement', { at: '2026-10-22T14:08:30Z' })]);
    await runSessionizer({ now: new Date('2026-10-22T16:05:00Z') });
    expect(rows('signalSession').find((x) => x.sessionId === SID)).toMatchObject({ leadId: body.leadId, leadCount: 1 });
  });

  it('no session: the form values are the attribution (cookie-only, origin ghl-fields)', async () => {
    await receiveGhlForm({ project: PROJECT, endpoint: ep, body: pinned({ attribution: { oa_sid: '', oa_vid: '' } }), now: new Date('2026-10-22T14:08:05Z') });
    const a = rows('leadAttribution')[0];
    expect(a).toMatchObject({ sessionId: null, model: 'cookie-only', lastClass: 'ai', lastSource: 'chatgpt', mismatch: false });
    expect(attributionSentence(a)[0]).toBe('Source recorded on the website: ChatGPT');
    expect(staffAttribution(a).match).toBe('fields');
  });

  it('no oa_sid: a form_submit of the same form within ±10 min is used, flagged mismatch (signal first, then lead)', async () => {
    await ingest([sig('visit', { at: '2026-10-22T14:00:00Z' }), sig('form_submit', { at: '2026-10-22T14:07:00Z' })]);
    await runSessionizer({ now: new Date('2026-10-22T16:00:00Z') });
    await receiveGhlForm({ project: PROJECT, endpoint: ep, body: pinned({ attribution: { oa_sid: '', oa_vid: '', ref_class: '', ai_source: '', source: '' } }), now: new Date('2026-10-22T14:08:05Z') });
    const a = rows('leadAttribution')[0];
    expect(a).toMatchObject({ sessionId: SID, mismatch: true });
    expect(a.siteSnapshot.match).toBe('time-window');
    await attributeLeads();
    expect(rows('leadAttribution')[0]).toMatchObject({ model: 'os-derived', mismatch: true });
    expect(staffAttribution(rows('leadAttribution')[0]).match).toBe('time-window');
  });

  it('±10 min the other way round (lead first, the signal later) and never outside the window or for another form', async () => {
    await receiveGhlForm({ project: PROJECT, endpoint: ep, body: pinned({ attribution: { oa_sid: '', oa_vid: '' } }), now: new Date('2026-10-22T14:08:05Z') });
    await ingest([sig('form_submit', { at: '2026-10-22T14:30:00Z', sessionId: 's_01JB3QFAR0000000000000000A' }), sig('form_submit', { at: '2026-10-22T14:09:00Z', sessionId: 's_01JB3QYYYY0000000000000000', formId: 'other-form' })]);
    await runSessionizer({ now: new Date('2026-10-22T16:00:00Z') });
    expect(rows('leadAttribution')[0].sessionId).toBeNull();
    await ingest([sig('form_submit', { at: '2026-10-22T14:10:00Z', sessionId: 's_01JB3QNEAR0000000000000000' })]);
    await runSessionizer({ now: new Date('2026-10-22T16:05:00Z') });
    expect(rows('leadAttribution')[0]).toMatchObject({ sessionId: 's_01JB3QNEAR0000000000000000', mismatch: true, needsDerive: true });
  });

  it('data quality leads.unmatched_form_submit: submits without a lead after 30 min, leads without a session', async () => {
    await ingest([sig('form_submit', { at: '2026-10-22T10:00:00Z', sessionId: 's_01JB3QZZZZ0000000000000000' }), sig('form_submit', { at: '2026-10-22T14:08:00Z' })]);
    await runSessionizer({ now: new Date('2026-10-22T16:00:00Z') });
    await receiveGhlForm({ project: PROJECT, endpoint: ep, body: pinned(), now: new Date('2026-10-22T14:08:05Z') });
    await receiveGhlForm({ project: PROJECT, endpoint: ep, body: pinned({ contact: { id: 'nosession0000000000' }, attribution: { oa_sid: '' } }), now: new Date('2026-10-22T09:00:00Z') });
    const q = await unmatchedFormSubmits('p1', { now: new Date('2026-10-22T16:00:00Z') });
    expect(q).toMatchObject({ key: 'leads.unmatched_form_submit', formSubmits: 2, unmatched: 1, heuristicUnmatched: 0, leads: 2, leadsWithoutSession: 1 });
    expect((await dataQuality('p1', { now: new Date('2026-10-22T16:00:00Z') })).unmatchedFormSubmit).toMatchObject({ unmatched: 1 });
  });
});

/* ───────────────────────────── contract 1.9.0 consumer ───────────────────────────── */

describe('contract 1.9.0: form_submit, lead.attributed externalRef, site-info forms, revision', () => {
  it('form_submit is a signal type (appended); provider / heuristic kept when valid, an unknown value dropped (not the signal)', async () => {
    expect(SIGNAL_TYPES[SIGNAL_TYPES.length - 1]).toBe('form_submit');
    const r = sanitizeSignal(FORM_SUBMIT, { siteId: SITE });
    expect(r.signal.lead).toEqual({ leadId: null, formId: 'ghl-contact', placement: 'embedded_form', provider: 'ghl' });
    const h = sanitizeSignal({ ...structuredClone(FORM_SUBMIT), lead: { leadId: null, formId: 'ghl-contact', placement: 'embedded_form', provider: 'nope', heuristic: 'sticky' } }, { siteId: SITE });
    expect(h.signal.lead).toEqual({ leadId: null, formId: 'ghl-contact', placement: 'embedded_form', heuristic: 'sticky' });
    expect(sanitizeSignal({ ...structuredClone(FORM_SUBMIT), lead: null }, { siteId: SITE }).error).toMatch(/lead is required/);
    const out = await ingestSignalsBatch(PROJECT, ex('events.request--form-submit').events[0], { now: new Date('2026-10-23T14:06:00Z') });
    expect(out).toBe('applied');
    const stored = rows('signalEvent').filter((e) => e.type === 'form_submit');
    expect(stored).toHaveLength(2);
    expect(stored.map((e) => e.payload.lead)).toEqual([
      { formId: 'ghl-contact', placement: 'embedded_form', provider: 'ghl' },
      { formId: 'ghl-contact', placement: 'embedded_form', provider: 'ghl', heuristic: 'height' },
    ]);
    expect(rows('signalIngestStat')[0]).toMatchObject({ rejectedInvalid: 0 });
    await runSessionizer({ now: new Date('2026-10-23T14:10:00Z') });
    expect(rows('signalSession').find((s) => s.sessionId === SID).formSubmits).toBe(1);
  });

  it('lead.attributed with externalRef joins our GHL lead on osLeadId, stores the mirror id, fills gaps (site-snapshot)', async () => {
    const ev = ex('events.request--lead-attributed-external').events[0];
    rows('cmsLead').push({ id: 'row1', projectId: 'p1', leadId: ev.data.externalRef.osLeadId, provider: 'ghl', erasedAt: null, siteCreatedAt: new Date('2026-10-23T14:03:11Z'), receivedAt: new Date(), cmsMirrorLeadId: null });
    rows('leadAttribution').push({ id: 'a1', projectId: 'p1', leadRowId: 'row1', siteLeadId: ev.data.externalRef.osLeadId, leadAt: new Date('2026-10-23T14:03:11Z'), model: 'cookie-only', siteSnapshot: { model: 'cookie-only', firstTouch: null, lastTouch: null, sessionId: null, origin: 'ghl' }, lastClass: 'unknown', lastSource: '', sessionId: null, needsDerive: false, mismatch: false });
    expect(await applyLeadAttributed(PROJECT, ev)).toBe('applied');
    expect(rows('cmsLead')[0].cmsMirrorLeadId).toBe(ev.data.leadId);
    const a = rows('leadAttribution')[0];
    expect(a).toMatchObject({ model: 'site-snapshot', lastClass: 'ads', lastSource: 'google', sessionId: SID });
    expect(a.siteSnapshot.origin).toBe('ghl');
    expect(rows('leadAttribution')).toHaveLength(1);
    // unknown osLeadId or an erased lead: nothing attached (never parked, never a new lead)
    const other = structuredClone(ev);
    other.data.externalRef.osLeadId = 'xg_01JB3QUNKNOWN000000000000';
    expect(await applyLeadAttributed(PROJECT, other)).toBe('stale');
    const bad = structuredClone(ev);
    bad.data.externalRef.provider = 'hubspot';
    await expect(applyLeadAttributed(PROJECT, bad)).rejects.toMatchObject({ code: 'VALIDATION' });
    // without externalRef an unknown leadId keeps parking (LEAD_NOT_STORED)
    const plain = structuredClone(ev);
    delete plain.data.externalRef;
    plain.data.leadId = '01JB3QNOTSTORED00000000001';
    await expect(applyLeadAttributed(PROJECT, plain)).rejects.toMatchObject({ code: 'LEAD_NOT_STORED' });
  });

  it('site-info leads.forms keep provider / external; the OS claims contract revision 1.9.0', () => {
    expect(SITE_INFO.leads.forms.map(sanitizeLeadForm)).toEqual([
      { id: 'quote', name: 'Request a quote', provider: 'emdash', external: false },
      { id: 'ghl-contact', name: 'Oasis Contact Form', provider: 'ghl', external: true },
    ]);
    expect(SITE_INFO.capabilities.leadImport).toBe(true);
    expect(CONTRACT_REVISION).toBe('1.9.0');
  });
});

/* ───────────────────────────── lead-import ───────────────────────────── */

describe('lead-import mirror job', () => {
  async function ghlLead(over = {}) {
    const { body } = await receiveGhlForm({ project: PROJECT, endpoint: { id: 'ep' }, body: pinned(over), now: new Date('2026-10-23T14:03:11Z') });
    return rows('cmsLead').find((l) => l.leadId === body.leadId);
  }

  it('builds a body valid against lead-import.request (contract schema) with a kind system actor; signals only from oa_sid', async () => {
    const lead = await ghlLead();
    const full = await prisma.cmsLead.findUnique({ where: { id: lead.id }, include: { attribution: true } });
    const body = buildLeadImportBody(full, await systemActor('p1'));
    expect(validateAgainst('lead-import.request.json', body)).toEqual([]);
    expect(validateAgainst('lead-import.request.json', ex('lead-import.request'))).toEqual([]);
    expect(body.lead).toMatchObject({ externalRef: { provider: 'ghl', id: 'pXy7Qe3LmN0aB1cD2eF3' }, osLeadId: lead.leadId, formId: 'ghl-contact', signals: { sid: SID, vid: VID }, pagePath: '/contact/', landing: '/spa-services/' });
    expect(body.lead.fields.extra.heard_from).toBe('AI assistant (ChatGPT, Perplexity…)');
    expect(body.actor).toEqual({ kind: 'system', osUserId: PROJECT.leadPmId, name: 'Agency OS lead import' });
    // a ±10 min guess is never sent as the visit
    full.attribution.siteSnapshot = { ...full.attribution.siteSnapshot, sessionId: null };
    expect(buildLeadImportBody(full, body.actor).lead.signals).toBeNull();
  });

  it('runs once with a deterministic UUID idempotency key, stores the mirror id, the site attribution fills gaps only', async () => {
    const lead = await ghlLead();
    spies.site.handler = async () => ex('lead-import.response');
    const out = await runLeadImportQueue({ now: new Date('2026-10-23T14:04:00Z') });
    expect(out).toMatchObject({ claimed: 1, done: 1 });
    expect(spies.site.calls).toHaveLength(1);
    const key = spies.site.calls[0].opts.idempotencyKey;
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(key).toBe(leadImportIdempotencyKey(lead));
    const row = rows('cmsLead')[0];
    expect(row).toMatchObject({ mirrorState: 'done', cmsMirrorLeadId: '01JB3QMIRROR00000000000001', mirrorAttempts: 1 });
    const a = rows('leadAttribution')[0];
    expect(a.siteSnapshot.model).toBe('site-snapshot');
    expect(a.siteSnapshot.formId).toBe('ghl-contact');
    expect(await runLeadImportQueue({ now: new Date('2026-10-23T15:00:00Z') })).toMatchObject({ claimed: 0 });
  });

  it('retries with backoff 1 min, 5 min, 30 min, 2 h, 12 h on 5xx / network, the SAME key every time, then failed', async () => {
    await ghlLead();
    spies.site.handler = async () => {
      throw new CmsBridgeError({ status: 503, code: 'UPSTREAM_UNAVAILABLE', retryable: true });
    };
    let now = new Date('2026-10-23T14:04:00Z');
    const waits = [];
    for (let i = 0; i < LEAD_IMPORT_MAX_ATTEMPTS; i += 1) {
      await runLeadImportQueue({ now });
      const r = rows('cmsLead')[0];
      if (r.mirrorState === 'pending') {
        waits.push(r.mirrorNextAt.getTime() - now.getTime());
        now = r.mirrorNextAt;
      }
    }
    expect(waits).toEqual([...LEAD_IMPORT_RETRY_DELAYS_MS]);
    expect(rows('cmsLead')[0]).toMatchObject({ mirrorState: 'failed', mirrorAttempts: 6, mirrorError: 'UPSTREAM_UNAVAILABLE' });
    expect(new Set(spies.site.calls.map((c) => c.opts.idempotencyKey)).size).toBe(1);
    expect(spies.site.calls).toHaveLength(6);
  });

  it.each([
    ['HUMAN_ONLY', 403, undefined, 'failed', 'HUMAN_ONLY'],
    ['NOT_IMPLEMENTED', 501, undefined, 'skipped', 'NOT_IMPLEMENTED'],
    ['NOT_IMPLEMENTED', 501, { reason: 'schema' }, 'pending', 'SITE_SCHEMA'],
    ['VALIDATION', 400, undefined, 'failed', 'VALIDATION'],
    ['IDEMPOTENCY_IN_PROGRESS', 409, undefined, 'pending', 'IDEMPOTENCY_IN_PROGRESS'],
    ['IDEMPOTENCY_MISMATCH', 409, undefined, 'failed', 'IDEMPOTENCY_MISMATCH'],
  ])('site error %s (%i, %j) → %s', async (code, status, details, state, error) => {
    await ghlLead();
    spies.site.handler = async () => {
      throw new CmsBridgeError({ status, code, details, retryable: code === 'IDEMPOTENCY_IN_PROGRESS' });
    };
    await runLeadImportQueue({ now: new Date('2026-10-23T14:04:00Z') });
    expect(rows('cmsLead')[0]).toMatchObject({ mirrorState: state, mirrorError: error });
    expect(classifyLeadImportError(new Error('socket'))).toBe('retry');
  });

  it('no double lead when the site later echoes the mirror: lead.created for the mirror id is ignored; lead.erased of the mirror keeps our row', async () => {
    await ghlLead();
    await runLeadImportQueue({ now: new Date('2026-10-23T14:04:00Z') });
    const echo = { type: 'lead.created', lead: { leadId: '01JB3QMIRROR00000000000001', form: { id: 'ghl-contact' }, fields: { name: 'Pat' }, consent: { contact: true } } };
    expect(await applyLeadEvent(PROJECT, echo)).toBe('stale');
    expect(rows('cmsLead')).toHaveLength(1);
    expect(rows('siteLeadDailyMetric')[0].leads).toBe(1);
    expect(spies.notify).toHaveLength(1);
    const withOrigin = structuredClone(echo);
    withOrigin.lead.leadId = '01JB3QOTHERMIRROR000000001';
    withOrigin.lead.origin = 'ghl';
    expect(await applyLeadEvent(PROJECT, withOrigin)).toBe('stale');
    expect(await applyLeadEvent(PROJECT, { type: 'lead.erased', leadId: '01JB3QMIRROR00000000000001' })).toBe('applied');
    expect(rows('cmsLead')).toHaveLength(1);
    expect(rows('cmsLead')[0]).toMatchObject({ cmsMirrorLeadId: null, erasedAt: null });
    // Health v2 L1 reads SiteLeadDailyMetric.leads: still exactly one lead
    expect(rows('siteLeadDailyMetric').reduce((s, r) => s + r.leads, 0)).toBe(1);
  });

  it('a site lead still counts as before (provider emdash, one notification, the metric providers dimension)', async () => {
    const created = ex('events.request--lead-attribution').events.find((e) => e.type === 'lead.created');
    expect(await applyLeadEvent(PROJECT, created)).toBe('applied');
    expect(rows('cmsLead')[0].provider).toBe('emdash');
    expect(rows('siteLeadDailyMetric')[0].breakdowns.providers).toEqual([{ provider: 'emdash', label: 'Website form', count: 1 }]);
    expect(spies.notify[0].variables.formLabel).toBe('website form');
    expect(await applyLeadEvent(PROJECT, created)).toBe('stale');
    expect(spies.notify).toHaveLength(1);
  });
});

/* ───────────────────────────── staff API ───────────────────────────── */

describe('Integrations API and lead routes', () => {
  let app;
  let who;
  beforeAll(async () => {
    app = Fastify();
    app.decorate('verifyJwt', async (request) => {
      request.user = who.user;
      if (who.token) request.authMethod = 'apiToken';
    });
    await app.register(pmGhlFormsRoutes, { prefix: '/api/pm' });
    await app.register(pmCmsLeadsReportsRoutes, { prefix: '/api/pm' });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    who = { user: OWNER };
  });
  const B = '/api/pm/projects/p1/integrations/ghl-forms';
  const call = (method, url, payload) => app.inject({ method, url, payload: method === 'POST' ? payload || {} : undefined, headers: { host: 'api.example.test', 'x-forwarded-proto': 'https' } });

  it('token shown ONCE (in the generate response only), rotate (new token, old valid 24 h), header secret once, revoke', async () => {
    const empty = (await call('GET', B)).json();
    expect(empty.endpoint).toEqual({ configured: false });
    const gen = (await call('POST', `${B}/token`)).json();
    expect(gen.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(gen.setup.url).toBe(`https://api.example.test/api/webhooks/ghl/forms/${gen.token}`);
    const again = (await call('GET', B)).json();
    expect(again.token).toBeUndefined();
    expect(JSON.stringify(again)).not.toContain(gen.token);
    expect(again.endpoint).toMatchObject({ configured: true, active: true, tokenPrefix: gen.token.slice(0, 6), headerSecret: false });
    expect(again.site).toMatchObject({ leadImport: true, ghlFormId: 'ghl-contact' });
    expect(again.site.forms).toContainEqual({ id: 'ghl-contact', name: 'Oasis Contact Form', provider: 'ghl', external: true });
    expect((await call('POST', `${B}/token`)).statusCode).toBe(409);
    const rot = (await call('POST', `${B}/rotate`)).json();
    expect(rot.token).not.toBe(gen.token);
    expect(rot.endpoint.previousTokenValidUntil).toBeTruthy();
    expect((await findEndpointByToken(gen.token)).matched).toBe('previous');
    const sec = (await call('POST', `${B}/header-secret`)).json();
    expect(sec.headerSecret).toBeTruthy();
    expect(sec.setup.headers).toContainEqual({ name: 'X-OS-Webhook-Secret', value: sec.headerSecret });
    expect((await call('GET', B)).json().headerSecret).toBeUndefined();
    const rev = (await call('POST', `${B}/revoke`)).json();
    expect(rev.endpoint).toMatchObject({ active: false, previousTokenValidUntil: null });
    expect(await findEndpointByToken(rot.token)).toBeNull();
  });

  it('receipts are counts / statuses only (no field values, no contact id); mirror items with state', async () => {
    const { endpoint } = await generateEndpoint('p1', OWNER);
    await receiveGhlForm({ project: PROJECT, endpoint, body: pinned() });
    await receiveGhlForm({ project: PROJECT, endpoint, body: pinned() });
    const v = (await call('GET', B)).json();
    expect(v.receipts.map((r) => r.status)).toEqual(expect.arrayContaining(['accepted', 'duplicate']));
    expect(JSON.stringify(v)).not.toMatch(/Pat|example\.com|555|pXy7Qe3LmN0aB1cD2eF3/);
    expect(v.mirror.counts).toEqual({ pending: 1 });
    expect(v.mirror.items[0]).toMatchObject({ state: 'pending', mirrored: false });
    expect(v.setup.body).toContain('4KKSBxHdlE5qWEtsdlCQ');
  });

  it('agents and API tokens: 403 HUMAN_ONLY on every write; tokens cannot read; TEAM_MEMBER / CLIENT 403; PM without access 403', async () => {
    for (const w of [{ user: { ...OWNER, isAgent: true } }, { user: OWNER, token: true }]) {
      who = w;
      for (const url of [`${B}/token`, `${B}/rotate`, `${B}/revoke`, `${B}/header-secret`, '/api/pm/projects/p1/cms-leads/xg_1/mirror-retry', '/api/pm/projects/p1/cms-leads/xg_1/external-erased', '/api/pm/projects/p1/cms-leads/xg_1/erase']) {
        const r = await call('POST', url);
        expect(r.statusCode, url).toBe(403);
        if (!url.endsWith('/erase')) expect(r.json().code).toBe('HUMAN_ONLY');
      }
    }
    who = { user: { ...OWNER, isAgent: true } };
    expect((await call('GET', B)).statusCode).toBe(200);
    who = { user: OWNER, token: true };
    expect((await call('GET', B)).json().code).toBe('HUMAN_ONLY');
    for (const role of ['TEAM_MEMBER', 'CONTRACTOR', 'CLIENT']) {
      who = { user: { id: 'x', role } };
      expect((await call('GET', B)).statusCode).toBe(403);
    }
    rows('clientAccount').push({ id: 'c1', leadPmId: 'someone-else', secondaryPmId: null });
    who = { user: { id: 'pm-x', role: 'PM' } };
    expect((await call('GET', B)).statusCode).toBe(403);
    expect(rows('externalFormEndpoint')).toHaveLength(0);
  });

  it('Retry (person, OWNER / PM) sends now as kind human; the leads list shows provider, GHL link (staff) and mirror state', async () => {
    const { body } = await receiveGhlForm({ project: PROJECT, endpoint: { id: 'ep' }, body: pinned() });
    rows('cmsLead')[0].mirrorState = 'failed';
    const r = await call('POST', `/api/pm/projects/p1/cms-leads/${body.leadId}/mirror-retry`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ state: 'done', mirrored: true });
    expect(spies.site.calls[0].body.actor).toMatchObject({ kind: 'human', osUserId: OWNER.id });
    expect((await call('POST', `/api/pm/projects/p1/cms-leads/${body.leadId}/mirror-retry`)).statusCode).toBe(409);
    const list = (await call('GET', '/api/pm/projects/p1/cms-leads')).json();
    expect(list.items[0]).toMatchObject({ provider: 'ghl', external: { provider: 'ghl', erasePending: false }, mirror: { state: 'done', mirrored: true } });
    expect(list.items[0].external.url).toContain('/contacts/detail/');
    expect(list.items[0].attribution.heardFrom).toBe('AI assistant (ChatGPT, Perplexity…)');
  });
});

/* ───────────────────────────── erasure ───────────────────────────── */

describe('erasure of a GHL lead', () => {
  it('with a mirror: lead-erase on the site by the MIRROR id, our copy + attribution erased, checklist item owed until ticked', async () => {
    const { body } = await receiveGhlForm({ project: PROJECT, endpoint: { id: 'ep' }, body: pinned() });
    await runLeadImportQueue({ now: new Date(Date.now() + 1000) });
    spies.site.handler = async (route) => (route === 'lead-erase' ? { ok: true, erased: true } : { ok: true });
    const out = await eraseLead({ projectId: 'p1', leadId: body.leadId, reason: 'subject_request', user: OWNER });
    expect(out).toMatchObject({ erased: true, sitePending: false, external: { provider: 'ghl', label: 'Delete the contact in GoHighLevel too' } });
    expect(out.external.url).toContain('/contacts/detail/pXy7Qe3LmN0aB1cD2eF3');
    const erase = spies.site.calls.find((c) => c.route === 'lead-erase');
    expect(erase.body.leadId).toBe('01JB3QMIRROR00000000000001');
    const row = rows('cmsLead')[0];
    expect(row).toMatchObject({ fields: null, externalErasePending: true });
    expect(row.erasedAt).toBeInstanceOf(Date);
    expect(rows('leadAttribution')).toHaveLength(0);
    // the site's lead.erased echo for the mirror changes nothing (no tombstone for the mirror id)
    expect(await applyLeadEvent(PROJECT, { type: 'lead.erased', leadId: '01JB3QMIRROR00000000000001' })).toBe('stale');
    expect(rows('cmsLead')).toHaveLength(1);
    expect(await confirmExternalErase('p1', body.leadId)).toBe(true);
    expect(rows('cmsLead')[0]).toMatchObject({ externalErasePending: false, externalUrl: null, externalId: null });
    expect(await confirmExternalErase('p1', body.leadId)).toBe(false);
  });

  it('O-C190-2: the erased lead visit form_submit goes too (not counted as unmatched); other sessions keep theirs', async () => {
    const { body } = await receiveGhlForm({ project: PROJECT, endpoint: { id: 'ep' }, body: pinned() });
    const sessionId = rows('leadAttribution')[0].sessionId;
    expect(sessionId).toBeTruthy();
    rows('signalEvent').push(
      { projectId: 'p1', eventId: 'fs1', sessionId, type: 'form_submit', leadId: null, at: new Date() },
      { projectId: 'p1', eventId: 'pv1', sessionId, type: 'pageview', leadId: null, at: new Date() },
      { projectId: 'p1', eventId: 'fs2', sessionId: 'other', type: 'form_submit', leadId: null, at: new Date() }
    );
    expect((await eraseLead({ projectId: 'p1', leadId: body.leadId, reason: 'spam', user: OWNER })).erased).toBe(true);
    expect(rows('signalEvent').map((e) => e.eventId).sort()).toEqual(['fs2', 'pv1']);
  });

  it('without a mirror (not imported yet): no site call; the queued import is cancelled', async () => {
    const { body } = await receiveGhlForm({ project: PROJECT, endpoint: { id: 'ep' }, body: pinned() });
    const out = await eraseLead({ projectId: 'p1', leadId: body.leadId, reason: 'spam', user: OWNER });
    expect(out.erased).toBe(true);
    expect(spies.site.calls).toHaveLength(0);
    expect(rows('cmsLead')[0]).toMatchObject({ mirrorState: 'cancelled', externalErasePending: true });
    expect(await runLeadImportQueue({ now: new Date(Date.now() + 60_000) })).toMatchObject({ claimed: 0 });
  });

  it('site unreachable: our copy is erased and the mirror erase is retried by the housekeeping with the mirror id', async () => {
    const { body } = await receiveGhlForm({ project: PROJECT, endpoint: { id: 'ep' }, body: pinned() });
    await runLeadImportQueue({ now: new Date(Date.now() + 1000) });
    spies.site.handler = async () => {
      throw new CmsBridgeError({ status: 503, code: 'UPSTREAM_UNAVAILABLE', retryable: true });
    };
    expect((await eraseLead({ projectId: 'p1', leadId: body.leadId, reason: 'subject_request', user: OWNER })).sitePending).toBe(true);
    const { retryPendingSiteErases } = await import('../../../src/lib/cmsLeads.js');
    spies.site.handler = async () => ({ ok: true, erased: true });
    spies.site.calls = [];
    await retryPendingSiteErases({ now: new Date(Date.now() + 3600_000) });
    expect(spies.site.calls[0]).toMatchObject({ route: 'lead-erase', body: { leadId: '01JB3QMIRROR00000000000001' } });
    expect(rows('cmsLead')[0].erasedReason).toBe('subject_request');
  });
});

/* ───────────────────────────── leads by source, retention ───────────────────────────── */

describe('Leads by source (provider dimension) and receipts retention', () => {
  it('bumpBreakdowns keeps rules / paths and adds providers; leadsByProvider / client view / staff overview split the forms', async () => {
    let b = bumpBreakdowns(null, { provider: 'ghl', formId: 'ghl-contact', sourcePath: '/contact/' });
    b = bumpBreakdowns(b, { provider: 'emdash', formId: 'quote', sourcePath: '/contact/' });
    expect(b.providers).toEqual([{ provider: 'ghl', label: 'GoHighLevel form', count: 1 }, { provider: 'emdash', label: 'Website form', count: 1 }]);
    expect(b.paths).toEqual([{ path: '/contact/', count: 2 }]);
    const now = new Date();
    await receiveGhlForm({ project: PROJECT, endpoint: { id: 'ep' }, body: pinned(), now });
    rows('cmsLead').push({ id: 'e1', projectId: 'p1', leadId: 'site1', provider: 'emdash', erasedAt: null, receivedAt: now });
    const from = new Date(now.getTime() - 86_400_000);
    const to = new Date(now.getTime() + 86_400_000);
    expect(await leadsByProvider('p1', from, to)).toEqual([{ provider: 'emdash', label: 'Website form', leads: 1 }, { provider: 'ghl', label: 'GoHighLevel form', leads: 1 }]);
    const client = await clientSignalsView(PROJECT, { now });
    expect(client.byProvider.thisMonth.find((p) => p.provider === 'ghl').leads).toBe(1);
    expect(client.recentLeads[0]).toMatchObject({ form: 'GoHighLevel form' });
    expect(JSON.stringify(client)).not.toMatch(/Pat|example\.com|pXy7Qe3LmN0aB1cD2eF3|contacts\/detail|xg_/);
    expect((await staffOverview(PROJECT, { from: from.toISOString(), to: to.toISOString() })).byProvider).toHaveLength(2);
  });

  it('receipts older than 90 days are purged in batches; newer ones stay', async () => {
    const now = new Date('2026-10-23T00:00:00Z');
    rows('externalFormReceipt').push({ id: 'old', projectId: 'p1', status: 'accepted', receivedAt: new Date('2026-07-01T00:00:00Z') }, { id: 'new', projectId: 'p1', status: 'accepted', receivedAt: new Date('2026-10-01T00:00:00Z') });
    expect(await purgeExternalFormReceipts({ now })).toEqual({ removed: 1 });
    expect(rows('externalFormReceipt').map((r) => r.id)).toEqual(['new']);
  });

  it('helpers: ULID shape; mergeSessionLeadIds maps a mirror id to our lead and adds attached GHL leads once', () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(mergeSessionLeadIds(['M1', 'L2'], [{ cmsMirrorLeadId: 'M1', leadId: 'xg_1' }], [{ siteLeadId: 'xg_1' }, { siteLeadId: 'xg_9' }])).toEqual(['xg_1', 'L2', 'xg_9']);
  });
});
