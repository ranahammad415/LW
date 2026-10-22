/**
 * Contract v1.7.0 §38.9 errata: a security CHECK may be `n/a` (a feature switched off: Visitor signals off, no backup
 * destination) with reason disabled | not_configured, plus an optional counts.na. The OS accepts it everywhere a check
 * state is validated or stored, never counts / scores / alerts it, ends acknowledgements on a transition to or from
 * it (no alert), shows it greyed out "Not applicable (<reason>)" to staff and never lists it to the client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../../src/lib/prisma.js', async () => {
  const { createFakePrisma } = await import('../signals/fakePrisma.js');
  return { prisma: createFakePrisma() };
});

import { prisma } from '../../../src/lib/prisma.js';
import { sanitizeCheck, sanitizeStatus, sanitizeHistory, sanitizeSecurityEventData, scoreOf, SECURITY_CHECK_STATES, SECURITY_STATES } from '../../../src/lib/siteAdapters/security.js';
import { alertForTransition } from '../../../src/lib/security/securityAlerts.js';
import { applyCheckChange } from '../../../src/lib/security/securityStore.js';
import { siteSecurityView, buildClientSecurityView } from '../../../src/lib/security/securityViews.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ex = (name) => JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract/examples', `${name}.json`), 'utf8'));
const rows = (n) => prisma._rows(n);

beforeEach(() => prisma._reset());

const check = (over = {}) => ({ id: 'app.signals_collector', category: 'app', severity: 'medium', state: 'n/a', reason: 'disabled', summary: 'Visitor signals are off; switch them on to run this check.', ...over });

describe('the n/a state is accepted', () => {
  it('check enum, reason, counts.na; overall / categories stay the four states', () => {
    expect(SECURITY_CHECK_STATES).toContain('n/a');
    expect(SECURITY_STATES).not.toContain('n/a');
    expect(sanitizeCheck(check())).toMatchObject({ state: 'n/a', reason: 'disabled' });
    expect(sanitizeCheck(check({ reason: 'not_configured' })).reason).toBe('not_configured');
    const st = sanitizeStatus(ex('security-status.response--na').status);
    expect(st).not.toBeNull();
    expect(st.checks.some((c) => c.state === 'n/a')).toBe(true);
    expect(st.overall.state).not.toBe('n/a');
    if (ex('security-status.response--na').status.overall.counts.na) expect(st.overall.counts.na).toBeGreaterThan(0);
    expect(sanitizeStatus({ overall: { state: 'n/a', score: 100 } })).toBeNull();
  });

  it('status_changed from / to and history points carry n/a', () => {
    const d = sanitizeSecurityEventData('security.status_changed', {
      before: { state: 'warn', score: 90 },
      after: { state: 'ok', score: 100 },
      changes: [{ id: 'app.signals_collector', from: 'fail', to: 'n/a', severity: 'medium', summary: 'off' }],
    }).data;
    expect(d.changes[0]).toMatchObject({ from: 'fail', to: 'n/a' });
    expect(sanitizeHistory([{ date: '2026-10-22', overallState: 'ok', score: 100, checks: { 'app.signals_collector': 'n/a' } }])[0].checks).toEqual({ 'app.signals_collector': 'n/a' });
  });

  it('no score weight', () => {
    expect(scoreOf([{ severity: 'critical', state: 'n/a' }])).toBe(100);
  });
});

describe('alerts and acknowledgements', () => {
  it('no alert on fail → n/a, nor on n/a → fail', async () => {
    const project = { id: 'p1' };
    expect(await alertForTransition(project, { checkId: 'backup.primary_fresh', from: 'fail', to: 'n/a', severity: 'critical' })).toEqual({ routed: 'not_applicable' });
    expect(await alertForTransition(project, { checkId: 'backup.primary_fresh', from: 'n/a', to: 'fail', severity: 'critical' })).toEqual({ routed: 'not_applicable' });
    expect(rows('securityAlertLog')).toHaveLength(0);
  });

  it('a transition to n/a ends the acknowledgement; the later n/a → fail sends no alert', async () => {
    rows('securityCheckState').push({ id: 'cs1', projectId: 'p1', checkId: 'backup.primary_fresh', state: 'fail', severity: 'critical', lastChangedAt: new Date('2026-10-20T00:00:00Z'), acknowledged: { at: '2026-10-20T01:00:00Z', until: '2026-10-25T00:00:00Z', state: 'fail', active: true } });
    await applyCheckChange('p1', { checkId: 'backup.primary_fresh', to: 'n/a', at: '2026-10-21T00:00:00Z', severity: 'critical', summary: 'no destination' }, { siteChanged: true });
    expect(rows('securityCheckState')[0]).toMatchObject({ state: 'n/a', acknowledged: null });
    expect(await alertForTransition({ id: 'p1' }, { checkId: 'backup.primary_fresh', from: 'n/a', to: 'fail', severity: 'critical' })).toEqual({ routed: 'not_applicable' });
  });
});

describe('views', () => {
  it('staff: greyed "not applicable" with its reason, outside the counts', async () => {
    rows('securitySiteStatus').push({ id: 's', projectId: 'p1', overallState: 'ok', score: 100, disabled: [] });
    rows('securityCheckState').push(
      { id: 'a', projectId: 'p1', checkId: 'app.signals_collector', category: 'app', severity: 'medium', state: 'n/a', reason: 'disabled' },
      { id: 'b', projectId: 'p1', checkId: 'edge.hsts', category: 'edge', severity: 'high', state: 'ok' },
      { id: 'c', projectId: 'p1', checkId: 'edge.csp_mode', category: 'edge', severity: 'low', state: 'warn' }
    );
    const v = await siteSecurityView({ id: 'p1', cmsType: 'EMDASH', cmsCapabilities: { security: true } });
    expect(v.status.counts).toMatchObject({ ok: 1, warn: 1, fail: 0, unknown: 0, na: 1 });
    expect(v.checks.find((c) => c.id === 'app.signals_collector')).toMatchObject({ state: 'n/a', reason: 'disabled', notApplicable: true });
  });

  it('client: never lists an n/a check', () => {
    const view = buildClientSecurityView({ status: { overallState: 'ok', disabled: [] }, checks: [{ checkId: 'app.signals_collector', clientSummary: 'Visit statistics are off', state: 'n/a', severity: 'medium' }] });
    expect(view.items).toEqual([]);
  });
});
