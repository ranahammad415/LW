/**
 * Regression tests for the backend review findings (H1, H2, M3, M5, M7).
 * Route-level fixes (M2, M4, M6, LOW items) are in publicInterviewRoutes.test.js;
 * scheduler fixes (M1, reminders, reaper scope) in interviewScheduler.test.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const kb = vi.hoisted(() => ({ files: {}, list: [] }));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    agencySetting: { findFirst: vi.fn().mockResolvedValue({ agencyName: 'Acme' }) },
    okfDraftChange: { create: vi.fn(async ({ data }) => ({ id: 'd', ...data })) },
    knowledgeInterviewInvite: { findUnique: vi.fn(), update: vi.fn() },
  },
}));
vi.mock('../../src/lib/knowledgeEngine.js', () => ({
  listClientFiles: () => kb.list,
  readOkfFile: (clientId, folder, filename) => {
    const key = `${folder}/${String(filename).replace(/\.md$/, '')}`;
    if (!(key in kb.files)) throw new Error('not found');
    return { metadata: { title: key }, body: kb.files[key] };
  },
  searchKnowledgeContext: () =>
    kb.list.map((a) => ({ asset: a, body: kb.files[`${a.folder}/${a.filename.replace(/\.md$/, '')}`] || '', score: 1 })),
}));
vi.mock('../../src/lib/expertInterview.js', async (orig) => ({
  ...(await orig()),
  upsertInterviewDrafts: vi.fn(async () => [{ id: 'd1', title: 't', folder: 'services', filename: 'x' }]),
}));

import { billedSeconds, MIN_CHARGE_SECONDS } from '../../src/lib/interviewSession.js';
import { rebaseDraftOnCurrent, mergeIntoCurrent, approvalMetadata } from '../../src/lib/interviewConsolidation.js';
import { sha256, processInterviewTool } from '../../src/lib/interviewCapture.js';
import { buildSummaryEmail } from '../../src/lib/interviewEmail.js';
import { redactSensitiveUrl, redactedRequestSerializer, redactSentryEvent } from '../../src/lib/logRedaction.js';
import { isFolderAllowed, lookupKnowledge } from '../../src/lib/interviewKnowledge.js';

const NOW = new Date('2026-10-15T10:00:00Z');

function file(folder, name, body) {
  kb.files[`${folder}/${name}`] = body;
  kb.list.push({ folder, filename: `${name}.md`, rel_path: `${folder}/${name}.md`, title: name });
}

beforeEach(() => {
  kb.files = {};
  kb.list = [];
});

describe('H1: the browser cannot lower the voice bill', () => {
  const session = (over = {}) => ({ mode: 'VOICE', startedAt: new Date(NOW.getTime() - 600e3), lastHeartbeatAt: null, ...over });

  it('complete bills the larger of server span, client and heartbeat span', () => {
    expect(billedSeconds(session(), { clientSeconds: 1, now: NOW })).toBe(600);
    expect(billedSeconds(session(), { clientSeconds: 700, now: NOW })).toBe(700);
  });

  it('caps at the session max and charges a minimum', () => {
    expect(billedSeconds(session({ startedAt: new Date(NOW.getTime() - 5 * 3600e3) }), { now: NOW })).toBe(900);
    expect(billedSeconds(session({ startedAt: new Date(NOW.getTime() - 2000) }), { now: NOW })).toBe(MIN_CHARGE_SECONDS);
  });

  it('reaped: wall clock when no heartbeat ever arrived; heartbeat span + grace otherwise', () => {
    expect(billedSeconds(session(), { now: NOW, reaped: true })).toBe(600);
    const hb = new Date(NOW.getTime() - 400e3); // heartbeat at 200 s
    expect(billedSeconds(session({ lastHeartbeatAt: hb }), { now: NOW, reaped: true })).toBe(230);
  });

  it('text is never billed', () => {
    expect(billedSeconds({ mode: 'TEXT', startedAt: new Date(0) }, { now: NOW })).toBe(0);
  });
});

describe('H2: approval rebases onto the current file', () => {
  it('a merged draft is re-merged when another draft changed the file since consolidation', () => {
    const atConsolidation = '# MOT\nFrom £40';
    const fragment = 'Same-day MOTs available';
    const draft = {
      title: 'Same day',
      sourceType: 'INTERVIEW_LINK',
      proposedBody: mergeIntoCurrent(atConsolidation, { title: 'Same day', content: fragment, date: NOW }),
      currentBodyHash: sha256(atConsolidation),
      proposedMetadata: { merged_into_current: true, capture_fragment: fragment },
    };
    // Another draft was approved first and added a line.
    const nowOnDisk = '# MOT\nFrom £40\n\n## Weekend hours (interview)\n\nOpen Saturdays';
    const { body, rebased } = rebaseDraftOnCurrent(draft, { body: nowOnDisk }, { now: NOW });
    expect(rebased).toBe(true);
    expect(body).toContain('Open Saturdays');
    expect(body).toContain(fragment);
  });

  it('unchanged file keeps the stored body', () => {
    const cur = '# MOT\nFrom £40';
    const draft = { title: 't', sourceType: 'INTERVIEW_LINK', proposedBody: 'X', currentBodyHash: sha256(cur), proposedMetadata: { merged_into_current: true, capture_fragment: 'f' } };
    expect(rebaseDraftOnCurrent(draft, { body: cur })).toEqual({ body: 'X', rebased: false });
  });

  it('confirm_change drafts re-apply old → new on the current body', () => {
    const draft = {
      sourceType: 'INTERVIEW_LINK',
      proposedBody: 'MOT from £45\n',
      currentBodyHash: sha256('MOT from £40\n'),
      proposedMetadata: { change: { field: 'price', old_value: '£40', new_value: '£45' } },
    };
    const { body } = rebaseDraftOnCurrent(draft, { body: 'MOT from £40\nCollection: free\n' });
    expect(body).toBe('MOT from £45\nCollection: free\n');
  });

  it('two NEW interview drafts for a file that did not exist: the second merges onto the first', () => {
    const draft = { title: 'Second fact', sourceType: 'INTERVIEW_LINK', proposedBody: 'Second fact text', currentBodyHash: null, proposedMetadata: {} };
    const { body } = rebaseDraftOnCurrent(draft, { body: 'First fact text' }, { now: NOW });
    expect(body).toContain('First fact text');
    expect(body).toContain('Second fact text');
  });

  it('other sources (crawl, portal voice) are left alone', () => {
    const draft = { title: 't', sourceType: 'WEBSITE_CRAWL', proposedBody: 'Whole page', proposedMetadata: {} };
    expect(rebaseDraftOnCurrent(draft, { body: 'Old' })).toEqual({ body: 'Whole page', rebased: false });
  });

  it('internal bookkeeping never reaches the front-matter', () => {
    expect(approvalMetadata({ title: 'x', capture_fragment: 'f', merged_into_current: true })).toEqual({ title: 'x' });
  });
});

describe('M3: summary email shows the captured fragment, not the merged file', () => {
  it('uses capture_fragment', async () => {
    const email = await buildSummaryEmail({
      root: { recipientName: 'Hina' },
      businessName: 'Al-Noor',
      agencyName: 'Acme',
      url: 'https://x/knowledge-interview/preview',
      captures: [{ title: 'Same day', folder: 'services', status: 'PENDING', proposedBody: 'SECRET OLD FILE BODY\n\nSame-day MOTs', proposedMetadata: { capture_fragment: 'Same-day MOTs' } }],
    });
    expect(email.html).toContain('Same-day MOTs');
    expect(email.html).not.toContain('SECRET OLD FILE BODY');
    expect(email.text).not.toContain('SECRET OLD FILE BODY');
  });
});

describe('M5: tokens are redacted from logs and Sentry', () => {
  it('redacts the interview token path segment and token query params', () => {
    expect(redactSensitiveUrl('/api/public/knowledge-interview/abc123XYZ/voice/s1/capture')).toBe('/api/public/knowledge-interview/[redacted]/voice/s1/capture');
    expect(redactSensitiveUrl('/api/realtime/p1?token=eyJ.a.b&x=1')).toBe('/api/realtime/p1?token=[redacted]&x=1');
    expect(redactSensitiveUrl('/api/admin/interviews')).toBe('/api/admin/interviews');
  });

  it('request serializer and Sentry event hook use the redacted URL', () => {
    expect(redactedRequestSerializer({ method: 'GET', url: '/api/public/knowledge-interview/tok', ip: '1.2.3.4' }).url).toBe('/api/public/knowledge-interview/[redacted]');
    const ev = redactSentryEvent({ request: { url: 'https://h/api/public/knowledge-interview/tok/finish' }, breadcrumbs: [{ data: { url: '/knowledge-interview/tok' } }] });
    expect(ev.request.url).not.toContain('tok/');
    expect(ev.breadcrumbs[0].data.url).toBe('/knowledge-interview/[redacted]');
  });
});

describe('M7: workers stay inside their cluster', () => {
  const worker = { id: 'w', rootInviteId: 'r', clientId: 'c1', respondentRole: 'STAFF', delegationDepth: 1, questionCluster: [{ id: 'q', folder: 'proof/testimonials' }] };
  const session = { id: 's', mode: 'VOICE' };

  it('a parent of an allowed folder is not allowed', () => {
    expect(isFolderAllowed('proof', ['proof/testimonials'])).toBe(false);
    expect(isFolderAllowed('proof/testimonials', ['proof/testimonials'])).toBe(true);
    expect(isFolderAllowed('services/boilers', ['services'])).toBe(true);
  });

  it('save_business_fact and confirm_change refuse folders outside the cluster', async () => {
    const save = await processInterviewTool({ invite: worker, session, tool: 'save_business_fact', args: { folder: 'company', filename: 'x', title: 't', content: 'abc' } });
    expect(save.result.ok).toBe(false);
    const change = await processInterviewTool({ invite: worker, session, tool: 'confirm_change', args: { folder: 'services', filename: 'mot', field: 'price', old_value: '1', new_value: '2', client_confirmed: true } });
    expect(change.result.ok).toBe(false);
    const ok = await processInterviewTool({ invite: worker, session, tool: 'save_business_fact', args: { folder: 'proof/testimonials', filename: 'x', title: 't', content: 'Great job' } });
    expect(ok.result.ok).toBe(true);
  });

  it('lookup: workers read profile but never approved claims', () => {
    file('company', 'profile', 'We fix cars');
    file('company', 'approved-claims', 'SECRET CLAIMS');
    file('proof', 'testimonials', 'Quote');
    const allow = ['proof/testimonials'];
    expect(lookupKnowledge({ clientId: 'c1', filename: 'company/approved-claims', allowFolders: allow }).results).toEqual([]);
    expect(lookupKnowledge({ clientId: 'c1', filename: 'company/profile', allowFolders: allow }).results).toHaveLength(1);
    const search = lookupKnowledge({ clientId: 'c1', query: 'anything', allowFolders: allow });
    expect(search.results.map((r) => r.path)).not.toContain('company/approved-claims');
  });
});
