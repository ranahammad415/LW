/**
 * Contract v1.3.0 §24: the ported osPublishDecision, schedule time rules, and the Review publish audit fields that the
 * OS mirrors (scheduledAt, publishOrigin, publishedBy, override).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { osPublishDecision, checkScheduleAt, OVERRIDE_REASON_MIN, SCHEDULE_MAX_AHEAD_DAYS, STAFF_PREVIEW_MAX_TTL_SEC } from '../../../src/lib/siteAdapters/publish.js';
import { normalizeReviewEvent, reviewToMirrorData, entryToPageData, MUTATION_ROUTES } from '../../../src/lib/siteAdapters/emdash.js';
import { ERROR_CODES } from '../../../src/lib/siteAdapters/signing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ex = (n) => JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract/examples', `${n}.json`), 'utf8'));

const owner = { kind: 'human', osUserId: 'o', name: 'O', role: 'OWNER' };
const pm = { kind: 'human', osUserId: 'p', name: 'P', role: 'PM' };
const caps = { publishFromOs: true };

describe('osPublishDecision (port)', () => {
  it('capability, agents, roles, state, override rules', () => {
    expect(osPublishDecision({ status: 'client_approved' }, { actor: pm }, {})).toMatchObject({ error: 'PUBLISH_NOT_ALLOWED' });
    expect(osPublishDecision({ status: 'client_approved' }, { actor: { ...pm, kind: 'agent' } }, caps)).toMatchObject({ error: 'PUBLISH_NOT_ALLOWED' });
    expect(osPublishDecision({ status: 'client_approved' }, { actor: { ...pm, role: 'TEAM_MEMBER' } }, caps)).toMatchObject({ error: 'FORBIDDEN' });
    expect(osPublishDecision({ status: 'client_approved' }, { actor: pm }, caps)).toEqual({ ok: true, override: false });
    expect(osPublishDecision({ status: 'pending_pm_review' }, { actor: pm }, caps)).toMatchObject({ error: 'INVALID_TRANSITION' });
    const reason = 'x'.repeat(OVERRIDE_REASON_MIN);
    expect(osPublishDecision({ status: 'pending_pm_review' }, { actor: pm, override: true, overrideReason: reason }, caps)).toMatchObject({ error: 'FORBIDDEN' });
    expect(osPublishDecision({ status: 'pending_pm_review' }, { actor: owner, override: true, overrideReason: 'short' }, caps)).toMatchObject({ error: 'VALIDATION' });
    expect(osPublishDecision({ status: 'pending_pm_review' }, { actor: owner, override: true, overrideReason: reason }, caps)).toEqual({ ok: true, override: true });
    expect(osPublishDecision({ status: 'published' }, { actor: owner, override: true, overrideReason: reason }, caps)).toMatchObject({ error: 'INVALID_TRANSITION' });
  });

  it('schedule window and constants', () => {
    const now = Date.parse('2026-10-17T00:00:00Z');
    expect(checkScheduleAt('2026-10-16T00:00:00Z', now).error).toBe('VALIDATION');
    expect(checkScheduleAt('nope', now).error).toBe('VALIDATION');
    expect(checkScheduleAt(new Date(now + 366 * 86_400_000).toISOString(), now).error).toBe('VALIDATION');
    expect(checkScheduleAt('2026-11-01T13:00:00.000Z', now)).toEqual({ ok: true, at: '2026-11-01T13:00:00Z' });
    expect([OVERRIDE_REASON_MIN, SCHEDULE_MAX_AHEAD_DAYS, STAFF_PREVIEW_MAX_TTL_SEC]).toEqual([20, 365, 3600]);
    for (const r of ['pipeline-publish', 'pipeline-schedule', 'pipeline-unschedule', 'preview-link']) expect(MUTATION_ROUTES.has(r), r).toBe(true);
    expect(ERROR_CODES.PUBLISH_BLOCKED).toEqual({ status: 409, retryable: false });
  });
});

describe('publish audit + scheduled state are mirrored', () => {
  it('scheduled Review → cmsScheduledAt; published Review → origin + publisher; override recorded', () => {
    const sched = reviewToMirrorData(ex('review.response--scheduled').review).data;
    expect(sched.status).toBe('scheduled');
    expect(sched.cmsScheduledAt.toISOString()).toBe('2026-11-01T13:00:00.000Z');
    const pub = reviewToMirrorData(ex('pipeline-publish.response').review).data;
    expect(pub).toMatchObject({ status: 'published', isPublished: true, cmsPublishOrigin: 'os', cmsPublishedBy: { name: 'Jane PM', source: 'os' }, cmsScheduledAt: null });
    const ov = normalizeReviewEvent(
      { ...ex('review.response--scheduled').review, override: { by: { kind: 'human', name: 'Agency Owner', source: 'os' }, reason: 'Client approved by phone, email follows', at: '2026-10-16T10:00:00Z', action: 'schedule' } },
      { eventType: 'pipeline_scheduled' }
    );
    expect(ov.cms.override).toEqual({ byName: 'Agency Owner', reason: 'Client approved by phone, email follows', at: '2026-10-16T10:00:00Z', action: 'schedule' });
  });

  it('scheduled entries carry scheduledAt on WpPage; other states clear it', () => {
    const e = { ...ex('inventory.response').items[0], status: 'scheduled', scheduledAt: '2026-11-01T13:00:00Z' };
    expect(entryToPageData(e, 'https://oasispoolspas.com').data.cmsScheduledAt.toISOString()).toBe('2026-11-01T13:00:00.000Z');
    expect(entryToPageData(ex('inventory.response').items[0], 'https://oasispoolspas.com').data.cmsScheduledAt).toBeNull();
  });
});
