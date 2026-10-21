/**
 * Contract v1.5.0 §26: leads (PII rules, photos, erasure, retention), site reports, and the WordPress → EmDash
 * history move (port of planWpHistoryMove, renumbering, preview, one-transaction apply, idempotency).
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';

const db = vi.hoisted(() => ({ calls: [], overrides: {} }));
const site = vi.hoisted(() => ({ handler: null, routes: [], notPaired: false }));

vi.mock('../../../src/lib/prisma.js', () => {
  const model = (name) =>
    new Proxy({}, {
      get(_, method) {
        const key = `${name}.${String(method)}`;
        return async (args) => {
          db.calls.push({ key, args });
          if (db.overrides[key]) return db.overrides[key](args);
          if (method === 'findMany') return [];
          if (method === 'count') return 0;
          if (method === 'updateMany' || method === 'deleteMany') return { count: 1 };
          if (method === 'create' || method === 'update' || method === 'upsert') return { id: 'row-1', ...(args?.data || args?.create || {}) };
          return null;
        };
      },
    });
  const base = {
    $queryRaw: async () => {
      db.calls.push({ key: '$queryRaw' });
      return [];
    },
  };
  const prisma = new Proxy(
    {
      ...base,
      $transaction: async (fn) => {
        db.calls.push({ key: '$transaction' });
        return typeof fn === 'function' ? fn(prisma) : Promise.all(fn);
      },
    },
    { get: (t, n) => (n in t ? t[n] : model(String(n))) }
  );
  return { prisma };
});
vi.mock('../../../src/lib/cmsStore.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadEmdashConnection: async () => {
    if (site.notPaired) {
      const { CmsBridgeError } = await import('../../../src/lib/siteAdapters/emdash.js');
      throw new CmsBridgeError({ status: 503, code: 'NOT_PAIRED', message: 'not paired' });
    }
    return { conn: { siteId: 'site_9f3c2a7b41d0', siteUrl: 'https://s.example' } };
  },
}));
vi.mock('../../../src/lib/siteAdapters/emdash.js', async (importOriginal) => {
  const orig = await importOriginal();
  const call = (route) => async (_c, body) => {
    site.routes.push(route);
    return site.handler(route, body);
  };
  return {
    ...orig,
    credentialToRings: () => ({ inbound: { current: { id: 1, secret: 'x' }, prev: null }, outbound: { current: { id: 1, secret: 'y' }, prev: null } }),
    emdashRoutes: { ...orig.emdashRoutes, leadErase: call('lead-erase'), redirectLedger: call('redirect-ledger'), missesSummary: call('misses-summary'), crawlLatest: call('crawl-latest'), migrationMap: call('migration-map') },
  };
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planWpHistoryMove, buildRekeyPlan, sanitizeMigratedFrom, sanitizeOutboxPause } from '../../../src/lib/siteAdapters/migration.js';
import { validateLeadEvent, leadToRow } from '../../../src/lib/siteAdapters/leads.js';
import { applyLeadEvent, copyLeadPhotos, eraseLocalLead, eraseLead, leadPhotoUrlAllowed, sweepOrphanLeadPhotos, busyRetryDelayMs, retryPendingSiteErases, parseErasedReason, SITE_ERASE_MAX_ATTEMPTS } from '../../../src/lib/cmsLeads.js';
import { CmsBridgeError } from '../../../src/lib/siteAdapters/emdash.js';
import { pullSiteReports, sanitizeReport } from '../../../src/lib/cmsReports.js';
import { previewMigration, applyMigration, mapHash, identityCheck, isMigrationActive } from '../../../src/lib/cmsMigration.js';
import { applyEmdashContentEvent, mirrorEmdashReview, prismaCmsStore, isForeignWpPage } from '../../../src/lib/cmsStore.js';
import { applyReviewEvent } from '../../../src/lib/reviewEvents.js';
import { processEventBatch } from '../../../src/routes/webhooks/emdash.js';
import { MUTATION_ROUTES } from '../../../src/lib/siteAdapters/emdash.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ex = (n) => JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract/examples', `${n}.json`), 'utf8'));
const calls = (key) => db.calls.filter((c) => c.key === key);
const leadEvents = () => ex('events.request--lead').events;
const PROJECT = { id: 'p1', cmsType: 'EMDASH', cmsSiteId: 'site_9f3c2a7b41d0', wpUrl: 'https://oasispoolspas.com' };

beforeAll(() => {
  process.env.CMS_LEADS_DIR = mkdtempSync(path.join(os.tmpdir(), 'cms-leads-test-'));
});
beforeEach(() => {
  db.calls = [];
  db.overrides = {};
  site.routes = [];
  site.handler = null;
  site.notPaired = false;
});

describe('leads (§26.1)', () => {
  it('validation: consent required, no snapshotText, ≤ 5 photos; messages never contain lead data', () => {
    const [created, erased] = leadEvents();
    expect(validateLeadEvent(created)).toBeNull();
    expect(validateLeadEvent(erased)).toBeNull();
    expect(validateLeadEvent({ ...created, lead: { ...created.lead, consent: { contact: false } } })).toMatch(/consent/);
    expect(validateLeadEvent({ ...created, snapshotText: 'x' })).toMatch(/snapshotText/);
    const msg = validateLeadEvent({ ...created, lead: { ...created.lead, photos: Array(6).fill(created.lead.photos[0]) } });
    expect(msg).not.toContain(created.lead.fields.email);
    expect(MUTATION_ROUTES.has('lead-erase')).toBe(true);
  });

  it('lead.created → CmsLead with PII + photo rows; analytics row carries no PII', async () => {
    const [created] = leadEvents();
    expect(await applyLeadEvent(PROJECT, created)).toBe('applied');
    const row = calls('cmsLead.create')[0].args.data;
    expect(row).toMatchObject({ projectId: 'p1', leadId: created.lead.leadId, fields: { email: 'pat@example.com' }, consentMarketing: false, spamVerdict: 'ok' });
    const photo = calls('cmsLeadPhoto.create')[0].args.data;
    expect(photo).toMatchObject({ mediaId: created.lead.photos[0].mediaId, sourceUrl: created.lead.photos[0].url });
    const analytics = calls('siteLeadEvent.create')[0].args.data;
    expect(analytics).toMatchObject({ eventType: 'form_submit', pagePath: '/spa-services/hot-tub-repair/' });
    for (const pii of ['Pat Example', 'pat@example.com', '555', 'Heater trips']) expect(JSON.stringify(analytics)).not.toContain(pii);
    expect(calls('siteLeadDailyMetric.create')[0].args.data).toMatchObject({ formSubmits: 1, leads: 1 });
  });

  it('e2e O16: one photo-link rule when storing; http://localhost works in the dev opt-in; a skipped photo records why', () => {
    const lead = leadEvents()[0].lead;
    const dev = { NODE_ENV: 'development', EMDASH_BRIDGE_ALLOW_INSECURE_DEV: 'true' };
    const local = 'http://localhost:4321/_emdash/api/plugins/agency-os-bridge/lead-photo?id=m1&sig=x';
    const withUrl = (url) => ({ ...lead, photos: [{ ...lead.photos[0], url }] });
    expect(leadToRow(withUrl(local), 's', { siteUrl: 'http://localhost:4321', env: dev }).photos[0]).toMatchObject({ sourceUrl: local });
    expect(leadToRow(withUrl(local), 's', { siteUrl: 'http://localhost:4321', env: {} }).photos[0]).toMatchObject({ sourceUrl: null, error: 'URL_NOT_ALLOWED' });
    expect(leadToRow(withUrl(local), 's', { siteUrl: 'http://localhost:4321', env: { ...dev, NODE_ENV: 'production' } }).photos[0].error).toBe('URL_NOT_ALLOWED');
    expect(leadToRow(withUrl('https://evil.example/_emdash/api/plugins/x/lead-photo'), 's', { siteUrl: 'https://oasispoolspas.com' }).photos[0]).toMatchObject({ sourceUrl: null, error: 'URL_NOT_ALLOWED' });
    expect(leadToRow(withUrl(undefined), 's', { siteUrl: 'https://oasispoolspas.com' }).photos[0]).toMatchObject({ sourceUrl: null, error: 'URL_MISSING' });
    expect(leadToRow(lead, 's', { siteUrl: 'https://oasispoolspas.com' }).photos[0]).toMatchObject({ sourceUrl: lead.photos[0].url });
    expect(leadToRow(lead, 's', { siteUrl: 'https://oasispoolspas.com' }).photos[0]).not.toHaveProperty('error');
  });

  it('e2e O16: a disallowed photo link still gets a row with its reason and no stored URL; nothing is fetched', async () => {
    const ev = leadEvents()[0];
    const bad = { ...ev, lead: { ...ev.lead, photos: [{ ...ev.lead.photos[0], url: 'https://cdn.example/_emdash/api/plugins/x/lead-photo?sig=1' }] } };
    expect(await applyLeadEvent(PROJECT, bad)).toBe('applied');
    expect(calls('cmsLeadPhoto.create')[0].args.data).toMatchObject({ sourceUrl: null, error: 'URL_NOT_ALLOWED' });
    expect(calls('cmsLeadPhoto.findMany')).toHaveLength(0); // no copy run started
  });

  it('a known or erased lead is never resurrected', async () => {
    db.overrides['cmsLead.findUnique'] = async () => ({ id: 'l1' });
    expect(await applyLeadEvent(PROJECT, leadEvents()[0])).toBe('stale');
    expect(calls('cmsLead.create')).toHaveLength(0);
  });

  it('lead.erased clears PII and photos, keeps an id-only tombstone; unknown leads get a tombstone', async () => {
    db.overrides['cmsLead.findUnique'] = async () => ({ id: 'l1', erasedAt: null, photos: [{ storageName: '0123456789abcdef0123456789abcdef.jpeg' }] });
    expect(await applyLeadEvent(PROJECT, leadEvents()[1])).toBe('applied');
    expect(calls('cmsLead.update')[0].args.data).toMatchObject({ fields: null, consent: null, utm: null, erasedReason: 'site' });
    expect(calls('cmsLeadPhoto.deleteMany')).toHaveLength(1);
    db.calls = [];
    db.overrides['cmsLead.findUnique'] = async () => null;
    await eraseLocalLead('p1', '01JAJ0LEAD0000000000000009', 'site');
    expect(calls('cmsLead.create')[0].args.data).toMatchObject({ leadId: '01JAJ0LEAD0000000000000009', erasedReason: 'site' });
    expect(calls('cmsLead.create')[0].args.data.fields).toBeUndefined();
  });

  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03]);
  const PHOTO = (q) => `https://s.example/_emdash/api/plugins/agency-os-bridge/lead-photo?${q}`;
  const LEAD = { erasedAt: null, project: { wpUrl: 'https://s.example' } };
  const writes = (key) => calls(key).map((c) => [c.args.where.id, c.args.data]);

  it('photos: copied into private storage (never kept as URLs), expired links dropped, non-images refused', async () => {
    const before = readdirSync(process.env.CMS_LEADS_DIR).length;
    const future = new Date(Date.now() + 86_400_000);
    db.overrides['cmsLeadPhoto.findMany'] = async () => [
      { id: 'ph1', sourceUrl: PHOTO('sig=a'), sourceExpiresAt: future, error: null, lead: LEAD },
      { id: 'ph2', sourceUrl: PHOTO('sig=b'), sourceExpiresAt: new Date(Date.now() - 1000), error: null, lead: LEAD },
      { id: 'ph3', sourceUrl: PHOTO('sig=c'), sourceExpiresAt: future, error: null, lead: LEAD },
    ];
    const fetchImpl = async (url) => new Response(url.endsWith('=c') ? Buffer.from('<svg/>') : JPEG, { status: 200 });
    expect(await copyLeadPhotos(null, { fetchImpl })).toBe(1);
    expect(calls('cmsLeadPhoto.findMany')[0].args).toMatchObject({ orderBy: { createdAt: 'asc' } });
    const w = writes('cmsLeadPhoto.updateMany');
    // ph1: claim (CAS on the observed error value) → copied only while still claimed and uncopied
    expect(calls('cmsLeadPhoto.updateMany')[0].args.where).toEqual({ id: 'ph1', copiedAt: null, error: null });
    expect(w[0][1].error).toMatch(/^COPYING@\d+$/);
    expect(calls('cmsLeadPhoto.updateMany')[1].args.where).toEqual({ id: 'ph1', copiedAt: null, error: w[0][1].error });
    expect(w[1][1]).toMatchObject({ sourceUrl: null, contentType: 'image/jpeg', error: null });
    expect(w[2]).toEqual(['ph2', { sourceUrl: null, error: 'EXPIRED' }]);
    // ph3: claimed, then a permanent error drops the link
    expect(w[4]).toEqual(['ph3', { error: 'NOT_IMAGE', sourceUrl: null }]);
    expect(readdirSync(process.env.CMS_LEADS_DIR).length - before).toBe(1);
  });

  it('review MEDIUM-LOW-6: claimed rows are skipped; an erase during the copy leaves no file; transient errors keep the link', async () => {
    const before = readdirSync(process.env.CMS_LEADS_DIR).length;
    const future = new Date(Date.now() + 86_400_000);
    db.overrides['cmsLeadPhoto.findMany'] = async () => [
      { id: 'live', sourceUrl: PHOTO('sig=a'), sourceExpiresAt: future, error: `COPYING@${Date.now() - 1000}`, lead: LEAD },
      { id: 'erased', sourceUrl: PHOTO('sig=b'), sourceExpiresAt: future, error: null, lead: { ...LEAD, erasedAt: new Date() } },
      { id: 'race', sourceUrl: PHOTO('sig=c'), sourceExpiresAt: future, error: `COPYING@${Date.now() - 600_000}`, lead: LEAD },
      { id: 'down', sourceUrl: PHOTO('sig=d'), sourceExpiresAt: future, error: null, lead: LEAD },
      { id: 'gone', sourceUrl: PHOTO('sig=e'), sourceExpiresAt: future, error: null, lead: LEAD },
    ];
    let n = 0;
    // 'race': the stale claim is taken over, then the lead is erased while fetching (the final CAS finds no row)
    db.overrides['cmsLeadPhoto.updateMany'] = async (args) => ({ count: args.where.id === 'race' && args.data.storageName ? 0 : 1 });
    const fetchImpl = async (url) => {
      n += 1;
      if (url.endsWith('=d')) return new Response('busy', { status: 503 });
      if (url.endsWith('=e')) return new Response('gone', { status: 404 });
      return new Response(JPEG, { status: 200 });
    };
    expect(await copyLeadPhotos(null, { fetchImpl })).toBe(0);
    expect(n).toBe(3); // 'live' (claimed elsewhere) and 'erased' never fetched
    const w = writes('cmsLeadPhoto.updateMany');
    expect(w.find(([id, d]) => id === 'race' && d.storageName)).toBeTruthy();
    expect(readdirSync(process.env.CMS_LEADS_DIR).length).toBe(before); // the written copy was deleted again
    expect(w.find(([id, d]) => id === 'down' && d.error === 'SITE_BUSY')[1]).not.toHaveProperty('sourceUrl'); // v1.5.4: 503 = site busy, link kept
    expect(w.find(([id, d]) => id === 'gone' && d.error === 'HTTP_404')[1]).toMatchObject({ sourceUrl: null });
  });

  it('review LOW-10 / MEDIUM-5: only the paired site host, https, the plugin path; the transport cap is 10 MiB', async () => {
    expect(leadPhotoUrlAllowed(PHOTO('sig=a'), 'https://s.example')).toBe(true);
    expect(leadPhotoUrlAllowed('https://s.example/blog/_emdash/api/plugins/x/lead-photo?sig=a', 'https://S.example/blog')).toBe(true); // path prefix allowed
    expect(leadPhotoUrlAllowed('https://evil.example/_emdash/api/plugins/x/lead-photo', 'https://s.example')).toBe(false);
    expect(leadPhotoUrlAllowed('https://cdn.s.example/_emdash/api/plugins/x/lead-photo', 'https://s.example')).toBe(false);
    expect(leadPhotoUrlAllowed('https://s.example/uploads/photo.jpg', 'https://s.example')).toBe(false);
    expect(leadPhotoUrlAllowed('http://s.example/_emdash/api/plugins/x/lead-photo', 'https://s.example', {})).toBe(false);
    expect(leadPhotoUrlAllowed('https://u:p@s.example/_emdash/api/plugins/x/lead-photo', 'https://s.example')).toBe(false);
    expect(leadPhotoUrlAllowed('https://s.example:8443/_emdash/api/plugins/x/lead-photo', 'https://s.example')).toBe(false);
    const future = new Date(Date.now() + 86_400_000);
    db.overrides['cmsLeadPhoto.findMany'] = async () => [
      { id: 'evil', sourceUrl: 'https://evil.example/_emdash/api/plugins/x/lead-photo?sig=a', sourceExpiresAt: future, error: null, lead: LEAD },
      { id: 'big', sourceUrl: PHOTO('sig=b'), sourceExpiresAt: future, error: null, lead: LEAD },
    ];
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push([url, init.maxBytes]);
      throw Object.assign(new Error('Response too large'), { code: 'RESPONSE_TOO_LARGE' });
    };
    await copyLeadPhotos(null, { fetchImpl });
    expect(seen).toEqual([[PHOTO('sig=b'), 10 * 1024 * 1024 + 1]]);
    const w = writes('cmsLeadPhoto.updateMany');
    expect(w.find(([id, d]) => id === 'evil' && d.error === 'URL_NOT_ALLOWED')[1]).toMatchObject({ sourceUrl: null });
    expect(w.find(([id, d]) => id === 'big' && d.error === 'TOO_LARGE')[1]).toMatchObject({ sourceUrl: null });
  });

  it('review MEDIUM-LOW-6: unreferenced photo files (e.g. a deleted project) are swept; recent files are left alone', async () => {
    const dir = process.env.CMS_LEADS_DIR;
    const { writeFileSync, utimesSync } = await import('node:fs');
    const old = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpeg';
    const kept = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.jpeg';
    const fresh = 'cccccccccccccccccccccccccccccccc.jpeg';
    for (const n of [old, kept, fresh]) writeFileSync(path.join(dir, n), 'x');
    const t = (Date.now() - 2 * 3600_000) / 1000;
    utimesSync(path.join(dir, old), t, t);
    utimesSync(path.join(dir, kept), t, t);
    db.overrides['cmsLeadPhoto.findMany'] = async (args) => (args.where.storageName ? [{ storageName: kept }] : []);
    expect(await sweepOrphanLeadPhotos()).toBe(1);
    const left = readdirSync(dir);
    expect(left).not.toContain(old);
    expect(left).toContain(kept);
    expect(left).toContain(fresh);
  });

  it('OS lead-erase: site first (OWNER actor + reason), then our copy', async () => {
    site.handler = () => ex('lead-erase.response');
    db.overrides['cmsLead.findUnique'] = async () => ({ id: 'l1', erasedAt: null, photos: [] });
    await expect(eraseLead({ projectId: 'p1', leadId: 'L', reason: 'whatever', user: { id: 'o', role: 'OWNER' } })).rejects.toMatchObject({ code: 'VALIDATION' });
    const out = await eraseLead({ projectId: 'p1', leadId: '01JAJ0LEAD0000000000000001', reason: 'subject_request', user: { id: 'o', name: 'Owner', role: 'OWNER' } });
    expect(out).toEqual({ erased: true, alreadyGone: false, sitePending: false });
    expect(site.routes).toEqual(['lead-erase']);
    expect(calls('cmsLead.update')[0].args.data.erasedReason).toBe('subject_request');
  });

  it('site unreachable or disconnected: our copy is still erased (PII, photo rows, files) and the site erase is pending', async () => {
    const OWNER = { id: '0f1e2d3c-4b5a-4968-8776-655443322110', name: 'Owner', role: 'OWNER' };
    const { writeFileSync } = await import('node:fs');
    const file = path.join(process.env.CMS_LEADS_DIR, 'a'.repeat(32) + '.jpg');
    writeFileSync(file, 'x');
    db.overrides['cmsLead.findUnique'] = async () => ({ id: 'l1', erasedAt: null, photos: [{ id: 'ph1', storageName: 'a'.repeat(32) + '.jpg' }] });
    site.handler = () => {
      throw new CmsBridgeError({ status: 503, code: 'UPSTREAM_UNAVAILABLE', message: 'down', retryable: true });
    };
    const out = await eraseLead({ projectId: 'p1', leadId: '01JAJ0LEAD0000000000000001', reason: 'subject_request', user: OWNER });
    expect(out).toEqual({ erased: true, alreadyGone: false, sitePending: true });
    expect(existsSync(file)).toBe(false);
    expect(calls('cmsLeadPhoto.deleteMany')[0].args.where).toEqual({ leadRowId: 'l1' });
    const upd = calls('cmsLead.update')[0].args.data;
    expect(upd).toMatchObject({ fields: null, consent: null, erasedReason: 'site_pending:subject_request' });
    expect(upd.utm.siteErase).toMatchObject({ attempts: 0, lastError: 'UPSTREAM_UNAVAILABLE', actor: { kind: 'human', osUserId: OWNER.id, role: 'OWNER' } });

    // disconnected (no credential): no site call at all, same outcome
    db.calls = [];
    site.routes = [];
    site.notPaired = true;
    const out2 = await eraseLead({ projectId: 'p1', leadId: '01JAJ0LEAD0000000000000001', reason: 'spam', user: OWNER });
    expect(out2.sitePending).toBe(true);
    expect(site.routes).toEqual([]);
    expect(calls('cmsLead.update')[0].args.data).toMatchObject({ erasedReason: 'site_pending:spam', utm: { siteErase: { lastError: 'NOT_PAIRED' } } });

    // the site says it no longer has the lead: nothing owed
    db.calls = [];
    site.notPaired = false;
    site.handler = () => {
      throw new CmsBridgeError({ status: 404, code: 'NOT_FOUND', message: 'gone' });
    };
    expect(await eraseLead({ projectId: 'p1', leadId: '01JAJ0LEAD0000000000000001', reason: 'other', user: OWNER })).toEqual({ erased: true, alreadyGone: true, sitePending: false });
    expect(calls('cmsLead.update')[0].args.data).toMatchObject({ erasedReason: 'other', utm: null });
  });

  it('pending site erases are retried by the housekeeping: success clears, backoff skips, repair-needed skips, last attempt -> failed', async () => {
    const now = new Date('2026-10-21T10:00:00Z');
    const actor = { kind: 'human', osUserId: '0f1e2d3c-4b5a-4968-8776-655443322110', name: 'Owner', role: 'OWNER' };
    const rows = [
      { id: 'a', projectId: 'p1', leadId: 'LA', erasedReason: 'site_pending:subject_request', utm: { siteErase: { attempts: 0, nextAt: '2026-10-21T09:00:00Z', actor } } },
      { id: 'b', projectId: 'p1', leadId: 'LB', erasedReason: 'site_pending:spam', utm: { siteErase: { attempts: 2, nextAt: '2026-10-21T11:00:00Z', actor } } },
      { id: 'c', projectId: 'p2', leadId: 'LC', erasedReason: 'site_pending:other', utm: { siteErase: { attempts: 0, actor } } },
    ];
    db.overrides['cmsLead.findMany'] = async (a) => {
      expect(a.where.erasedReason).toEqual({ startsWith: 'site_pending:' });
      return rows;
    };
    db.overrides['project.findUnique'] = async (a) => ({ cmsRepairNeededAt: a.where.id === 'p2' ? new Date() : null });
    const bodies = [];
    site.handler = (_r, body) => {
      bodies.push(body);
      return { ok: true, erased: true };
    };
    const out = await retryPendingSiteErases({ now });
    expect(out).toEqual({ tried: 1, done: 1, failed: 0 });
    expect(bodies).toEqual([{ leadId: 'LA', reason: 'subject_request', actor }]);
    expect(calls('cmsLead.update')[0].args).toEqual({ where: { id: 'a' }, data: { erasedReason: 'subject_request', utm: null } });

    // failures: attempts counted with backoff; the last one marks it failed
    db.calls = [];
    rows.splice(0, 3,
      { id: 'd', projectId: 'p1', leadId: 'LD', erasedReason: 'site_pending:spam', utm: { siteErase: { attempts: SITE_ERASE_MAX_ATTEMPTS - 2, actor } } },
      { id: 'e', projectId: 'p1', leadId: 'LE', erasedReason: 'site_pending:spam', utm: { siteErase: { attempts: SITE_ERASE_MAX_ATTEMPTS - 1, actor } } });
    site.handler = () => {
      throw new CmsBridgeError({ status: 503, code: 'UPSTREAM_UNAVAILABLE', message: 'down' });
    };
    expect(await retryPendingSiteErases({ now })).toEqual({ tried: 2, done: 0, failed: 1 });
    const [d, e] = calls('cmsLead.update').map((c) => c.args.data);
    expect(d.erasedReason).toBe('site_pending:spam');
    expect(d.utm.siteErase).toMatchObject({ attempts: SITE_ERASE_MAX_ATTEMPTS - 1, lastError: 'UPSTREAM_UNAVAILABLE' });
    expect(Date.parse(d.utm.siteErase.nextAt)).toBeGreaterThan(now.getTime());
    expect(e.erasedReason).toBe('site_failed:spam');
    expect(e.utm.siteErase.nextAt).toBeNull();
    expect(parseErasedReason('site_failed:spam')).toEqual({ reason: 'spam', siteErase: 'failed' });
    expect(parseErasedReason('retention')).toEqual({ reason: 'retention', siteErase: null });
  });

  it('a lead.erased from the site on a tombstone with a pending site erase clears the pending mark', async () => {
    db.overrides['cmsLead.findUnique'] = async () => ({ id: 'l1', erasedAt: new Date(), erasedReason: 'site_pending:subject_request', photos: [] });
    expect(await eraseLocalLead('p1', 'L', 'site')).toBe(true);
    expect(calls('cmsLead.update')[0].args.data).toEqual({ erasedReason: 'subject_request', utm: null });
  });

  it('e2e O17: erasing an unknown id (e.g. our row id) is a 404: no site call, no tombstone', async () => {
    db.overrides['cmsLead.findUnique'] = async () => null;
    await expect(eraseLead({ projectId: 'p1', leadId: '7d0c6c55-1111-4222-8333-944444444444', reason: 'subject_request', user: { id: 'o', name: 'Owner', role: 'OWNER' } })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(site.routes).toEqual([]);
    expect(calls('cmsLead.create')).toHaveLength(0);
  });

  it('a failing lead apply is logged with a code only (no lead data)', async () => {
    const logged = [];
    const store = {
      claimReceipt: async () => 'new',
      finalizeReceipt: async () => {},
      releaseReceipt: async () => {},
      applyLeadEvent: async () => {
        throw Object.assign(new Error('Unique constraint failed on value pat@example.com'), { code: 'P2002' });
      },
    };
    const log = { error: (obj) => logged.push(obj) };
    const r = await processEventBatch({ store, project: PROJECT, events: [leadEvents()[0]], log });
    expect(r.rejected[0]).toMatchObject({ code: 'INTERNAL', retryable: true });
    expect(JSON.stringify(logged)).not.toContain('pat@example.com');
    expect(JSON.stringify(r)).not.toContain('pat@example.com');
  });
});

describe('reports (§26.2)', () => {
  it('pulls the three reports (read-only) and stores them; sites without `reports` are refused', async () => {
    db.overrides['project.findUnique'] = async () => ({ cmsType: 'EMDASH', cmsCapabilities: { reports: true }, cmsRepairNeededAt: null });
    site.handler = (route) => ex(`${route}.response`);
    expect(await pullSiteReports('p1')).toEqual({ 'redirect-ledger': 'ok', 'misses-summary': 'ok', 'crawl-latest': 'ok' });
    expect(calls('cmsSiteReport.upsert')).toHaveLength(3);
    expect(sanitizeReport('misses-summary', ex('misses-summary.response')).items[0]).toMatchObject({ path: '/hot-tubs-for-sale/', hits: 31 });
    db.overrides['project.findUnique'] = async () => ({ cmsType: 'EMDASH', cmsCapabilities: {} });
    await expect(pullSiteReports('p1')).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });
});

describe('WordPress → EmDash migration (§26.3)', () => {
  const map = ex('migration-map.response');
  const wpPages = [
    { id: 'pg118', wpPostId: 118, url: 'https://old.oasispoolspas.com/hot-tub-repair/' },
    { id: 'pg204', wpPostId: 204, url: 'https://old.oasispoolspas.com/2023/winter-tips/' },
    { id: 'pg311', wpPostId: 311, url: 'https://old.oasispoolspas.com/old-promo/' },
    { id: 'pg900', wpPostId: 900, url: 'https://old.oasispoolspas.com/unknown/' },
  ];
  const WPP = {
    id: 'p1', cmsType: 'WORDPRESS', wpUrl: 'https://old.oasispoolspas.com', wpApiKey: 'aaaa9c1f', cmsSiteId: 'site_9f3c2a7b41d0',
    cmsMigration: { state: 'paired', siteUrl: 'https://oasispoolspas.com' },
  };

  it('port of planWpHistoryMove + renumbering with collisions', () => {
    const plan = planWpHistoryMove({ wpPages, wpReviews: [{ wpPipelineId: 7, wpPostId: 118, status: 'published', isPublished: true }, { wpPipelineId: 8, wpPostId: 204, status: 'pending_pm_review' }] }, map.items);
    expect(plan.pages.map((p) => p.wpPostId)).toEqual([118]);
    expect(plan.redirected.map((p) => p.wpPostId)).toEqual([204]);
    expect(plan.dropped.map((p) => p.wpPostId)).toEqual([311]);
    expect(plan.unmatched).toEqual([900]);
    expect(plan.blockers).toEqual([8]);
    expect(plan.ok).toBe(false);
    // entry_no 204 for post 118: 118 moves to 204; EVERY other WordPress page is parked at -id (review HIGH-1),
    // every WordPress review at -reviewNo (review MEDIUM-HIGH-2); postIdMap re-points review page references.
    const p2 = planWpHistoryMove({ wpPages, wpReviews: [] }, [{ ...map.items[0], entry_no: 204 }, map.items[1]]);
    const rk = buildRekeyPlan(p2, wpPages, [{ wpPipelineId: 7 }, { wpPipelineId: 12, cmsReviewId: '01R' }]);
    expect(rk).toMatchObject({ moves: [{ from: 118, to: 204 }], parks: [{ from: 204, to: -204 }, { from: 311, to: -311 }, { from: 900, to: -900 }], reviewParks: [{ from: 7, to: -7 }], conflicts: [] });
    expect([...rk.postIdMap]).toEqual([[118, 204], [204, -204], [311, -311], [900, -900]]);
    // a parking number already taken, or an entry_no held by an EmDash row, is a conflict (apply refuses)
    expect(buildRekeyPlan(p2, [...wpPages, { wpPostId: -311 }]).conflicts).toEqual([{ wpPostId: 311, reason: 'parking number -311 is taken' }]);
    expect(buildRekeyPlan(p2, [...wpPages.filter((p) => p.wpPostId !== 204), { wpPostId: 204, cmsEntryId: '01E' }]).conflicts).toHaveLength(1);
    expect(buildRekeyPlan(planWpHistoryMove({ wpPages, wpReviews: [] }, [map.items[0], { ...map.items[0], wp_post_id: 311 }]), wpPages).conflicts).toHaveLength(1);
    expect(sanitizeMigratedFrom({ ...map.migratedFrom, wpPluginKeyHint: 'secretkey9c1f' }).wpPluginKeyHint).toBe('9c1f');
  });

  it('identity check: old URL host and the key hint', () => {
    expect(identityCheck(WPP, map.migratedFrom)).toMatchObject({ siteUrlMatches: true, keyHintMatches: true });
    expect(identityCheck({ ...WPP, wpUrl: 'https://other.example' }, map.migratedFrom).siteUrlMatches).toBe(false);
    expect(isMigrationActive(WPP)).toBe(true);
    expect(isMigrationActive({ ...WPP, cmsType: 'EMDASH' })).toBe(false);
  });

  it('preview is a dry run: only the preview summary is stored', async () => {
    db.overrides['project.findUnique'] = async () => WPP;
    db.overrides['cmsCredential.findUnique'] = async () => ({ keyId: 1 });
    db.overrides['wpPage.findMany'] = async () => wpPages;
    db.overrides['wpContentReview.findMany'] = async () => [{ id: 'r7', wpPipelineId: 7, wpPostId: 118, status: 'published', isPublished: true, postTitle: 'Hot tub' }];
    site.handler = () => map;
    const out = await previewMigration('p1', { user: { id: 'o' } });
    expect(out).toMatchObject({ canApply: true, summary: { pagesMigrated: 1, reviewsMoved: 1, redirected: 1, dropped: 1, unmatched: 1, blockers: [] } });
    expect(out.mapHash).toBe(mapHash(map.items.map((i) => i)));
    const writes = db.calls.filter((c) => /\.(update|updateMany|create|upsert|delete|deleteMany)$/.test(c.key));
    expect(writes.map((w) => w.key)).toEqual(['project.update']);
    expect(writes[0].args.data.cmsMigration).toMatchObject({ state: 'previewed', preview: { mapHash: out.mapHash } });
    expect(calls('$queryRaw')).toHaveLength(1); // project row locked for the write
  });

  it('review LOW-7: a preview never overwrites an applied migration', async () => {
    let n = 0;
    // first read (outside the lock) still says paired; the locked re-read sees another instance's apply
    db.overrides['project.findUnique'] = async () => (n++ === 0 ? WPP : { ...WPP, cmsType: 'EMDASH', cmsMigration: { ...WPP.cmsMigration, state: 'applied' } });
    db.overrides['cmsCredential.findUnique'] = async () => ({ keyId: 1 });
    site.handler = () => map;
    await expect(previewMigration('p1', { user: { id: 'o' } })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(calls('project.update')).toHaveLength(0);
  });

  it('apply: one transaction, project row locked, history moved (nothing deleted), cut-over; second call is a no-op', async () => {
    let state = { ...WPP, cmsMigration: { ...WPP.cmsMigration, state: 'previewed', preview: { mapHash: mapHash(map.items) } } };
    db.overrides['project.findUnique'] = async () => state;
    db.overrides['cmsCredential.findUnique'] = async () => ({ keyId: 1 });
    db.overrides['wpPage.findMany'] = async () => wpPages;
    db.overrides['wpContentReview.findMany'] = async () => [{ id: 'r7', wpPipelineId: 7, wpPostId: 118, parentWpPostId: null, status: 'published', isPublished: true }];
    db.overrides['contentMapNode.updateMany'] = async () => ({ count: 2 });
    site.handler = () => map;
    await expect(applyMigration('p1', { user: { id: 'o' }, mapHash: 'stale' })).rejects.toMatchObject({ code: 'CONFLICT_REV' });
    const out = await applyMigration('p1', { user: { id: 'o' }, mapHash: mapHash(map.items) });
    expect(out).toMatchObject({ pagesMigrated: 1, reviewsMoved: 1, reviewsParked: 1, parked: 3, redirected: 1, dropped: 1, unmatched: 1, nodesRewritten: 2 });
    expect(calls('$transaction')).toHaveLength(1);
    expect(calls('$queryRaw')).toHaveLength(1);
    expect(db.calls.some((c) => /\.(delete|deleteMany)$/.test(c.key))).toBe(false);
    const pageUpdates = calls('wpPage.update').map((c) => [c.args.where.id, c.args.data]);
    expect(pageUpdates.find(([id]) => id === 'pg118')[1]).toMatchObject({ cmsEntryId: map.items[0].entry_id, cmsCollection: 'pages', url: 'https://oasispoolspas.com/spa-services/hot-tub-repair/', cmsMigration: { status: 'migrated', oldWpPostId: 118 } });
    // review HIGH-1: every non-migrated WordPress page is parked at -id with its status (no EmDash number lands on it)
    expect(pageUpdates.find(([id]) => id === 'pg204')[1]).toMatchObject({ wpPostId: -204, cmsMigration: { status: 'redirected', redirectType: 301, parked: true } });
    expect(pageUpdates.find(([id]) => id === 'pg311')[1]).toMatchObject({ wpPostId: -311, cmsMigration: { status: 'dropped', parked: true } });
    expect(pageUpdates.find(([id]) => id === 'pg900')[1]).toMatchObject({ wpPostId: -900, cmsMigration: { status: 'unmatched', parked: true } });
    // review MEDIUM-HIGH-2: the WordPress review is parked at -reviewNo and keeps its (migrated) page
    expect(calls('wpContentReview.update')[0].args.data).toEqual({ wpPipelineId: -7, cmsEntryId: map.items[0].entry_id, wpPostId: 118 });
    const cut = calls('project.update').at(-1).args.data;
    expect(cut).toMatchObject({ cmsType: 'EMDASH', wpUrl: 'https://oasispoolspas.com', wpApiKey: null, cmsMigration: { state: 'applied', oldWpUrl: 'https://old.oasispoolspas.com', oldWpKeyHint: '9c1f', counterFloor: { entryNo: 900, reviewNo: 7 } } });
    // idempotent: once applied, the stored result comes back without any write
    state = { ...state, cmsType: 'EMDASH', cmsMigration: cut.cmsMigration };
    db.calls = [];
    expect(await applyMigration('p1', { user: { id: 'o' }, mapHash: mapHash(map.items) })).toMatchObject({ alreadyApplied: true, pagesMigrated: 1 });
    expect(db.calls.filter((c) => /\.(update|create)$/.test(c.key))).toHaveLength(0);
  });

  it('open WordPress reviews block the move; an identity mismatch needs explicit confirmation', async () => {
    const state = { ...WPP, cmsMigration: { ...WPP.cmsMigration, state: 'previewed', preview: { mapHash: mapHash(map.items) } } };
    db.overrides['project.findUnique'] = async () => state;
    db.overrides['cmsCredential.findUnique'] = async () => ({ keyId: 1 });
    db.overrides['wpPage.findMany'] = async () => wpPages;
    db.overrides['wpContentReview.findMany'] = async () => [{ id: 'r8', wpPipelineId: 8, wpPostId: 204, status: 'pending_pm_review', isPublished: false }];
    site.handler = () => map;
    await expect(applyMigration('p1', { user: { id: 'o' }, mapHash: mapHash(map.items) })).rejects.toMatchObject({ code: 'MIGRATION_BLOCKED', details: { blockers: [8] } });
    expect(calls('wpPage.update')).toHaveLength(0);
    db.overrides['project.findUnique'] = async () => ({ ...state, wpUrl: 'https://different.example' });
    await expect(applyMigration('p1', { user: { id: 'o' }, mapHash: mapHash(map.items) })).rejects.toMatchObject({ code: 'IDENTITY_UNCONFIRMED' });
  });
  const previewed = () => ({ ...WPP, cmsMigration: { ...WPP.cmsMigration, state: 'previewed', preview: { mapHash: mapHash(map.items) } } });

  it('review MEDIUM-3: reviews of parked pages follow their page; tombstones are parked; floor covers the window', async () => {
    const state = previewed();
    db.overrides['project.findUnique'] = async () => state;
    db.overrides['cmsCredential.findUnique'] = async () => ({ keyId: 1 });
    db.overrides['wpPage.findMany'] = async () => wpPages;
    db.overrides['wpContentReview.findMany'] = async () => [
      { id: 'r9', wpPipelineId: 9, wpPostId: 204, parentWpPostId: 900, status: 'published', isPublished: true },
      { id: 'r30', wpPipelineId: 30, wpPostId: 311, parentWpPostId: 118, status: 'cancelled', isPublished: true },
    ];
    db.overrides['wpContentReviewTombstone.findMany'] = async () => [{ id: 't1', wpPipelineId: 41 }];
    db.overrides['wpContentReviewTombstone.aggregate'] = async () => ({ _max: { wpPipelineId: 41 } });
    site.handler = () => map;
    await applyMigration('p1', { user: { id: 'o' }, mapHash: mapHash(map.items) });
    const rv = Object.fromEntries(calls('wpContentReview.update').map((c) => [c.args.where.id, c.args.data]));
    expect(rv.r9).toEqual({ wpPipelineId: -9, wpPostId: -204, parentWpPostId: -900 });
    expect(rv.r30).toEqual({ wpPipelineId: -30, wpPostId: -311, parentWpPostId: 118 });
    expect(calls('wpContentReviewTombstone.update')[0].args).toEqual({ where: { id: 't1' }, data: { wpPipelineId: -41 } });
    expect(calls('project.update').at(-1).args.data.cmsMigration.counterFloor).toEqual({ entryNo: 900, reviewNo: 41 });
  });

  it('review LOW-8: state, preview hash and site URL are re-checked under the lock; an empty move needs confirmation', async () => {
    db.overrides['cmsCredential.findUnique'] = async () => ({ keyId: 1 });
    db.overrides['wpPage.findMany'] = async () => wpPages;
    site.handler = () => map;
    let n = 0;
    db.overrides['project.findUnique'] = async () => (n++ === 0 ? previewed() : { ...previewed(), cmsMigration: { ...previewed().cmsMigration, preview: { mapHash: 'other' } } });
    await expect(applyMigration('p1', { user: { id: 'o' }, mapHash: mapHash(map.items) })).rejects.toMatchObject({ code: 'CONFLICT_REV' });
    n = 0;
    db.overrides['project.findUnique'] = async () => (n++ === 0 ? previewed() : { ...previewed(), cmsMigration: { ...previewed().cmsMigration, siteUrl: 'https://elsewhere.example' } });
    await expect(applyMigration('p1', { user: { id: 'o' }, mapHash: mapHash(map.items) })).rejects.toMatchObject({ code: 'CONFLICT_REV' });
    expect(calls('wpPage.update')).toHaveLength(0);
    // a map that migrates nothing
    const empty = { ...map, items: map.items.filter((i) => i.status !== 'migrated') };
    const st = { ...WPP, cmsMigration: { ...WPP.cmsMigration, state: 'previewed', preview: { mapHash: mapHash(empty.items) } } };
    db.overrides['project.findUnique'] = async () => st;
    site.handler = () => empty;
    await expect(applyMigration('p1', { user: { id: 'o' }, mapHash: mapHash(empty.items) })).rejects.toMatchObject({ code: 'MIGRATION_EMPTY' });
    expect(calls('project.update')).toHaveLength(0);
    expect(await applyMigration('p1', { user: { id: 'o' }, mapHash: mapHash(empty.items), confirmEmpty: true })).toMatchObject({ pagesMigrated: 0, parked: 4 });
  });

  it('review HIGH-1 / MEDIUM-HIGH-2: after cut-over EmDash never writes a WordPress row; the stored floor is sent', async () => {
    const applied = { id: 'p1', cmsType: 'EMDASH', wpUrl: 'https://oasispoolspas.com', cmsSiteId: 'site_9f3c2a7b41d0', cmsMigration: { state: 'applied', counterFloor: { entryNo: 900, reviewNo: 41 } } };
    const wpRow = { id: 'pgX', title: 'Old', contentHash: 'h', content: '', cmsEntryId: null, cmsMigration: { status: 'unmatched', parked: true } };
    expect(isForeignWpPage(wpRow)).toBe(true);
    expect(isForeignWpPage({ ...wpRow, cmsEntryId: '01E' })).toBe(false);
    expect(isForeignWpPage({ ...wpRow, cmsMigration: null })).toBe(false); // native EmDash project rows are untouched by this rule
    db.overrides['wpPage.findUnique'] = async () => wpRow;
    const ev = ex('events.request').events.find((e) => e.type === 'content.saved') || { type: 'content.saved', entry: { entryId: '01E', entryNo: 5, collection: 'pages', slug: 'x', status: 'published', title: 'T' } };
    expect(await applyEmdashContentEvent(applied, ev)).toBe('ignored');
    expect(calls('wpPage.update')).toHaveLength(0);
    expect(calls('wpPageSnapshot.create')).toHaveLength(0);
    expect(calls('wpPage.create')).toHaveLength(0);
    // review mirror: an existing row without cmsReviewId on a migrated project is foreign
    db.overrides['project.findUnique'] = async () => applied;
    db.overrides['wpContentReview.findUnique'] = async () => ({ id: 'rW', status: 'published', isPublished: true, cmsReviewId: null });
    const review = ex('pipeline-list.response').items?.[0] || ex('pipeline-list.response').reviews?.[0];
    expect(await mirrorEmdashReview('p1', review)).toBeNull();
    expect(calls('wpContentReview.updateMany').length + calls('wpContentReview.upsert').length).toBe(0);
    // control: the EmDash row itself (cmsReviewId set) is still mirrored
    db.overrides['wpContentReview.findUnique'] = async () => ({ id: 'rE', status: 'pending_pm_review', isPublished: false, cmsReviewId: review.reviewId });
    await mirrorEmdashReview('p1', review);
    expect(calls('wpContentReview.updateMany').length + calls('wpContentReview.upsert').length).toBe(1);
    db.overrides['wpContentReview.findUnique'] = async () => ({ id: 'rW', status: 'published', isPublished: true, cmsReviewId: null });
    // review event: skipped, never merged
    const out = await applyReviewEvent({ project: applied, event: { source: 'EMDASH', wpPipelineId: 3, eventType: 'pipeline_submitted', wpPostId: 5, status: 'pending_pm_review', cms: {} } });
    expect(out).toEqual({ skipped: 'foreign_row' });
    // counter floor: the stored floor wins over the (now negative) WordPress numbers
    db.overrides['wpContentReview.aggregate'] = async () => ({ _max: { wpPipelineId: 2 } });
    db.overrides['wpPage.aggregate'] = async () => ({ _max: { wpPostId: 118 } });
    expect(await prismaCmsStore.getCounterFloor('p1')).toEqual({ reviewNo: 41, entryNo: 900 });
  });
});

describe('v1.5.3 §29: outbox pause (stored from site-info / handshake / health)', () => {
  it('sanitizes health.outbox.paused and stores it with the heartbeat', async () => {
    const info = ex('site-info.response--migration-pending');
    await prismaCmsStore.recordHeartbeat({ projectId: 'p1', siteInfo: info, contract: 1, now: new Date('2026-10-21T00:00:00Z') });
    const stored = calls('project.update').at(-1).args.data.cmsHealth.outbox;
    expect(stored.paused).toEqual({ reason: 'migration_pending', since: '2026-10-20T09:00:00.000Z', until: '2026-11-19T09:00:00.000Z' });
    expect(sanitizeOutboxPause(ex('health.response--paused').outbox.paused)).toMatchObject({ reason: 'migration_pending' });
    for (const bad of [null, undefined, {}, { reason: 'other', since: '2026-10-20T09:00:00Z', until: '2026-11-19T09:00:00Z' }, { reason: 'migration_pending', since: 'x', until: '2026-11-19T09:00:00Z' }]) {
      expect(sanitizeOutboxPause(bad)).toBeNull();
    }
    // a site below 1.5.3 (no paused field): stored as null
    const old = ex('site-info.response');
    await prismaCmsStore.recordHeartbeat({ projectId: 'p1', siteInfo: old, contract: 1 });
    const o = calls('project.update').at(-1).args.data.cmsHealth.outbox;
    if (o) expect(o.paused).toBeNull();
  });
});

describe('v1.5.4 §30.1: service user role (site-info.serviceToken)', () => {
  it('stored normalised from a 1.5.4 site; ignored from an older one; never the token', async () => {
    const info = ex('site-info.response--service-role');
    await prismaCmsStore.recordHeartbeat({ projectId: 'p1', siteInfo: info, contract: 1 });
    const st = calls('project.update').at(-1).args.data.cmsHealth.serviceToken;
    expect(st).toMatchObject({ usable: true, role: 'author', requiredRole: 'editor', meetsRequiredRole: false, problems: [{ code: 'ROLE_INSUFFICIENT' }] });
    await prismaCmsStore.recordHeartbeat({ projectId: 'p1', siteInfo: { ...info, contractRevision: '1.5.3' }, contract: 1 });
    expect(calls('project.update').at(-1).args.data.cmsHealth).not.toHaveProperty('serviceToken');
  });

  it('e2e O25: a heartbeat without serviceToken keeps the last known value; one that carries it overwrites', async () => {
    const info = ex('site-info.response--service-role');
    const { serviceToken: _st, ...heartbeat } = info;
    const stored = { usable: true, role: 'author', requiredRole: 'editor', meetsRequiredRole: false, checkedAt: null, problems: [] };
    db.overrides['project.findUnique'] = async () => ({ cmsHealth: { serviceToken: stored } });
    await prismaCmsStore.recordHeartbeat({ projectId: 'p1', siteInfo: heartbeat, contract: 1 });
    expect(calls('project.update').at(-1).args.data.cmsHealth.serviceToken).toEqual(stored);
    await prismaCmsStore.recordHeartbeat({ projectId: 'p1', siteInfo: { ...heartbeat, serviceToken: { ...info.serviceToken, role: 'editor', meetsRequiredRole: true, problems: [] } }, contract: 1 });
    expect(calls('project.update').at(-1).args.data.cmsHealth.serviceToken).toMatchObject({ role: 'editor', meetsRequiredRole: true });
    const { sanitizeServiceToken } = await import('../../../src/lib/siteAdapters/push.js');
    expect(sanitizeServiceToken({ usable: true, role: 'boss', token: 'secret', problems: [{ code: 'NOPE' }, { code: 'SCOPE_MISSING', message: 'm' }] })).toEqual({
      usable: true, role: 'unknown', requiredRole: 'editor', meetsRequiredRole: null, checkedAt: null, problems: [{ code: 'SCOPE_MISSING', message: 'm' }],
    });
  });
});

describe('v1.5.4 §30.7: lead photo 503 + Retry-After after a site restart', () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03]);
  const URL1 = 'https://s.example/_emdash/api/plugins/agency-os-bridge/lead-photo?sig=busy';
  const LEAD = { erasedAt: null, project: { wpUrl: 'https://s.example' } };

  it('keeps the link (SITE_BUSY), retries the lead after Retry-After, then copies; never past the retry budget', async () => {
    const future = new Date(Date.now() + 86_400_000);
    let busy = true;
    db.overrides['cmsLeadPhoto.findMany'] = async () => [{ id: 'phB', sourceUrl: URL1, sourceExpiresAt: future, error: null, lead: LEAD }];
    const fetchImpl = async () => (busy ? new Response('restarting', { status: 503, headers: { 'retry-after': '60' } }) : new Response(JPEG, { status: 200 }));
    const scheduled = [];
    const schedule = (fn, ms) => scheduled.push({ fn, ms });
    expect(await copyLeadPhotos('l1', { fetchImpl, busyRetries: 2, schedule })).toBe(0);
    const failed = calls('cmsLeadPhoto.updateMany').map((c) => c.args.data).find((d) => d.error === 'SITE_BUSY');
    expect(failed).toEqual({ error: 'SITE_BUSY' }); // sourceUrl kept
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(60_000);
    busy = false;
    await scheduled[0].fn();
    expect(calls('cmsLeadPhoto.updateMany').some((c) => c.args.data.storageName)).toBe(true);
    // budget: with no retries left nothing more is scheduled
    busy = true;
    scheduled.length = 0;
    await copyLeadPhotos('l1', { fetchImpl, busyRetries: 0, schedule });
    expect(scheduled).toHaveLength(0);
    // the hourly run (no lead id) never schedules; an expired link is still dropped
    db.overrides['cmsLeadPhoto.findMany'] = async () => [{ id: 'phE', sourceUrl: URL1, sourceExpiresAt: new Date(Date.now() - 1000), error: 'SITE_BUSY', lead: LEAD }];
    await copyLeadPhotos(null, { fetchImpl, busyRetries: 3, schedule });
    expect(scheduled).toHaveLength(0);
    expect(calls('cmsLeadPhoto.updateMany').at(-1).args.data).toEqual({ sourceUrl: null, error: 'EXPIRED' });
    expect(busyRetryDelayMs(undefined)).toBe(60_000);
    expect(busyRetryDelayMs('3600')).toBe(180_000);
  });
});

describe('v1.5.5 §31.1: serviceToken in the heartbeat body', () => {
  it('a heartbeat that carries it refreshes the stored value', async () => {
    const hb = ex('handshake.request--heartbeat-service-token');
    db.overrides['project.findUnique'] = async () => ({ cmsHealth: { serviceToken: { usable: true, role: 'editor', requiredRole: 'editor', meetsRequiredRole: true, checkedAt: null, problems: [] } } });
    await prismaCmsStore.recordHeartbeat({ projectId: 'p1', siteInfo: hb, contract: 1 });
    const st = calls('project.update').at(-1).args.data.cmsHealth.serviceToken;
    expect(st).toMatchObject({ usable: true, role: 'author', meetsRequiredRole: false });
    expect(st.problems.map((p) => p.code)).toEqual(['ROLE_INSUFFICIENT', 'SCOPE_MISSING']);
  });
});
