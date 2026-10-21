/**
 * Monthly security report (plan §5.7): HTML editions (client without ids / scores / evidence / versions / hosts; admin
 * with the appendix), escaping, the leader job (never overwrites), and the routes (client edition only on
 * /api/client/*, CSP header, scoping).
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';

const db = vi.hoisted(() => ({ calls: [], overrides: {} }));
vi.mock('../../../src/lib/prisma.js', () => {
  const model = (name) =>
    new Proxy({}, {
      get(_, method) {
        const key = `${name}.${String(method)}`;
        return async (args) => {
          db.calls.push({ key, args });
          if (db.overrides[key]) return db.overrides[key](args);
          if (method === 'findMany') return [];
          if (method === 'upsert') return { id: 'r', month: args.where.projectId_month.month };
          return null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});

import { renderSecurityReport, monthRange, generateMonthlySecurityReports, generateSecurityReport, isReportMonth } from '../../../src/lib/security/securityReport.js';
import { clientSecurityRoutes } from '../../../src/routes/client/security.js';
import { pmSecurityRoutes } from '../../../src/routes/pm/security.js';
import { HTML_REPORT_VIEW_CSP } from '../../../src/lib/htmlReportUpload.js';

const DATA = {
  month: '2026-10',
  days: 31,
  project: { id: 'p1', name: 'Oasis <Pool>' },
  status: {
    overallState: 'warn',
    score: 93,
    catalogueVersion: '1.0.0',
    sentinelVersion: '0.1.0',
    lastBuild: { commit: 'cd08cc1', npmAudit: { critical: 0, high: 0 } },
    backups: { agency: { offsite: { destinationType: 's3', lastOkAt: '2026-10-31T08:31:30Z' } }, client: [{ destinationId: 'dst_1', type: 'sftp', label: 'Office NAS', files: { lastOkAt: '2026-10-30T07:05:40Z' } }] },
    lastRestoreTest: { at: '2026-10-28T03:40:12Z', result: 'ok' },
  },
  points: [
    { date: '2026-10-01', overallState: 'ok', score: 98, checks: { 'edge.cloudflare_proxied': 'ok' } },
    { date: '2026-10-31', overallState: 'warn', score: 93, checks: { 'edge.cloudflare_proxied': 'ok' } },
  ],
  transitions: [
    { checkId: 'backup.primary_fresh', fromState: 'ok', toState: 'warn', at: new Date('2026-10-30T08:00:00Z'), severity: 'critical', clientSummary: 'Files backup is late.' },
    { checkId: 'edge.hsts', fromState: 'fail', toState: 'ok', at: new Date('2026-10-10T08:00:00Z'), severity: 'high', clientSummary: null },
  ],
  runs: [
    { owner: 'agency', result: 'ok', finishedAt: new Date('2026-10-01T08:30:00Z') },
    { owner: 'agency', result: 'ok', finishedAt: new Date('2026-10-02T08:30:00Z') },
    { owner: 'client', destinationId: 'dst_1', result: 'failed', startedAt: new Date('2026-10-30T07:05:00Z') },
  ],
  checks: [
    { checkId: 'backup.primary_fresh', state: 'warn', severity: 'critical', clientSummary: 'Files backup is late.', summary: 'Files archive 27 h old', evidence: { filesAgeH: 27, path: '~/oasis-data' }, remediation: 'Check the cron', pmNote: 'Re-running <tonight>', pmNoteEta: new Date('2026-11-02T12:00:00Z') },
    { checkId: 'edge.hsts', state: 'ok', severity: 'high', clientSummary: 'Browsers always use a secure connection.', summary: 'HSTS ok' },
    { checkId: 'email.dmarc_policy', state: 'fail', severity: 'medium', clientSummary: null, summary: 'DMARC p=none' },
  ],
  incidents: [{ phase: 'closed', severity: 'high', summary: 'Spam wave', lastAt: new Date('2026-10-15T00:00:00Z') }],
};

beforeEach(() => {
  db.calls = [];
  db.overrides = {};
});

describe('render', () => {
  it('client edition: plain language only; admin edition adds the appendix', () => {
    const { clientHtml, adminHtml, overallState } = renderSecurityReport(DATA, { planNote: 'Enforce CSP <now>', agencyName: 'Localwaves' });
    expect(overallState).toBe('warn');
    for (const forbidden of ['backup.primary_fresh', 'edge.hsts', 'email.dmarc', 'score', '93', 'filesAgeH', 'oasis-data', 'Check the cron', '1.0.0', '0.1.0', 'cd08cc1', 'dst_1', 'sftp', 'agency edition', 'Appendix']) {
      expect(clientHtml).not.toContain(forbidden);
    }
    expect(clientHtml).toContain('Files backup is late.');
    expect(clientHtml).toContain('Re-running &lt;tonight&gt;');
    expect(clientHtml).toContain('Enforce CSP &lt;now&gt;');
    expect(clientHtml).toContain('Oasis &lt;Pool&gt;');
    expect(clientHtml).toContain('2 of 31');
    expect(clientHtml).toContain('Office NAS');
    expect(clientHtml).not.toMatch(/<script/i);
    expect(adminHtml).toContain('Appendix (agency only)');
    expect(adminHtml).toContain('backup.primary_fresh');
    expect(adminHtml).toContain('filesAgeH');
    expect(adminHtml).toContain('Spam wave');
    expect(adminHtml).toContain('Logs are not collected yet');
  });

  it('month helpers', () => {
    expect(monthRange('2026-02')).toMatchObject({ days: 28, from: '2026-02-01', to: '2026-02-28' });
    expect(isReportMonth('2026-13')).toBe(false);
    expect(isReportMonth('2026-10')).toBe(true);
  });
});

describe('generation', () => {
  it('stores both editions; the monthly job does last month and never overwrites an existing report', async () => {
    db.overrides['project.findUnique'] = async () => DATA.project;
    const r = await generateSecurityReport('p1', '2026-10', { userId: 'u1', planNote: 'x'.repeat(3000) });
    expect(r.month).toBe('2026-10');
    const up = db.calls.find((c) => c.key === 'securityMonthlyReport.upsert').args;
    expect(up.create.clientHtml).toContain('<!doctype html>');
    expect(up.create.generatedById).toBe('u1');
    db.calls = [];
    db.overrides['project.findMany'] = async () => [
      { id: 'p1', cmsType: 'EMDASH', cmsCapabilities: { security: true } },
      { id: 'p2', cmsType: 'EMDASH', cmsCapabilities: { security: true } },
      { id: 'p3', cmsType: 'EMDASH', cmsCapabilities: {} },
    ];
    db.overrides['securityMonthlyReport.findUnique'] = async (a) => (a.where.projectId_month.projectId === 'p2' ? { id: 'existing' } : null);
    const out = await generateMonthlySecurityReports({ now: new Date('2026-11-01T06:00:00Z') });
    expect(out).toEqual({ month: '2026-10', generated: 1 });
  });
});

describe('routes', () => {
  let app;
  let who;
  beforeAll(async () => {
    app = Fastify();
    app.decorate('verifyJwt', async (request) => {
      request.user = who.user;
    });
    app.decorate('requireClient', async (request) => {
      request.clientAccountIds = who.clientIds || [];
    });
    await app.register(clientSecurityRoutes, { prefix: '/api/client' });
    await app.register(pmSecurityRoutes, { prefix: '/api/pm' });
    await app.ready();
  });
  afterAll(() => app.close());

  it('client: only the client edition, with the report CSP; other clients 404', async () => {
    who = { user: { id: 'c', role: 'CLIENT' }, clientIds: ['c1'] };
    db.overrides['project.findUnique'] = async () => ({ id: 'p1', clientId: 'c1', cmsType: 'EMDASH', cmsCapabilities: { security: true } });
    db.overrides['securityMonthlyReport.findUnique'] = async (a) => {
      expect(a.select).toEqual({ clientHtml: true });
      return { clientHtml: '<p>client</p>' };
    };
    const res = await app.inject({ method: 'GET', url: '/api/client/projects/p1/security/reports/2026-10?edition=admin' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<p>client</p>');
    expect(res.headers['content-security-policy']).toBe(HTML_REPORT_VIEW_CSP);
    who.clientIds = ['other'];
    expect((await app.inject({ method: 'GET', url: '/api/client/projects/p1/security/reports/2026-10' })).statusCode).toBe(404);
  });

  it('staff: admin edition by default, client edition on request; generate validates the month', async () => {
    who = { user: { id: 'o', role: 'OWNER' } };
    db.overrides['project.findUnique'] = async () => ({ id: 'p1', clientId: 'c1', cmsType: 'EMDASH', cmsCapabilities: { security: true } });
    db.overrides['securityMonthlyReport.findUnique'] = async () => ({ clientHtml: '<p>client</p>', adminHtml: '<p>admin</p>' });
    expect((await app.inject({ method: 'GET', url: '/api/pm/security/projects/p1/reports/2026-10' })).body).toBe('<p>admin</p>');
    expect((await app.inject({ method: 'GET', url: '/api/pm/security/projects/p1/reports/2026-10?edition=client' })).body).toBe('<p>client</p>');
    expect((await app.inject({ method: 'POST', url: '/api/pm/security/projects/p1/reports', payload: { month: '2026-1' } })).statusCode).toBe(400);
  });
});
