/**
 * e2e Phase 1 OS issues 1 and 4 + contract v1.0.4 §17(a): what the leader sync polls, how it reacts to a
 * site that rejects our keys, and which replayed events it imports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  findManyArgs: [],
  replay: null,
  listError: null,
  flagged: [],
  batches: [],
  project: { id: 'p1', cmsSiteId: 'site_current01', cmsLastCursor: 21 },
}));

vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: {
    project: {
      findMany: async (args) => {
        h.findManyArgs.push(args);
        return [{ id: 'p1' }];
      },
    },
    wpContentReviewEvent: { count: async () => 1 },
  },
}));
vi.mock('../../../src/lib/cmsKeyCrypto.js', async (orig) => ({ ...(await orig()), isCmsKeyCryptoConfigured: () => true }));
vi.mock('../../../src/lib/notificationService.js', () => ({ notify: vi.fn(async () => {}) }));
vi.mock('../../../src/lib/contentMapSync.js', () => ({ reconcileProjectMapsSafe: vi.fn(), mirrorPipelineToMaps: vi.fn(async () => {}) }));
vi.mock('../../../src/lib/cmsStore.js', () => ({
  loadEmdashConnection: async () => ({ project: h.project, conn: { siteUrl: 'https://s.example', siteId: 'site_current01', inbound: {} } }),
  mirrorEmdashReview: async () => null,
  backfillEmdashHistory: async () => 0,
  prismaCmsStore: {
    flagRepairNeeded: async (pid, reason) => {
      h.flagged.push({ pid, reason });
      return true;
    },
    findCounterRegression: async () => null,
    setLastCursor: async () => {},
  },
}));
vi.mock('../../../src/routes/webhooks/emdash.js', () => ({
  processEventBatch: async ({ events }) => {
    h.batches.push(events);
    return { accepted: events.map((e) => e.eventId), heal: [], storedCursor: 0 };
  },
}));
vi.mock('../../../src/lib/siteAdapters/emdash.js', async (orig) => {
  const real = await orig();
  return {
    ...real,
    emdashRoutes: {
      ...real.emdashRoutes,
      pipelineList: async () => {
        if (h.listError) throw h.listError;
        return { items: [], next: null };
      },
      eventsReplay: async () => h.replay,
    },
  };
});

import { syncEmdashPipelines, replayEmdashEvents } from '../../../src/lib/emdashSync.js';
import { CmsBridgeError } from '../../../src/lib/siteAdapters/emdash.js';

beforeEach(() => {
  h.findManyArgs = [];
  h.flagged = [];
  h.batches = [];
  h.listError = null;
});

describe('leader sync scope (issue 4)', () => {
  it('polls only paired, non-archived projects without a re-pair flag', async () => {
    await syncEmdashPipelines();
    expect(h.findManyArgs[0].where).toMatchObject({
      cmsType: 'EMDASH',
      cmsPairedAt: { not: null },
      status: { not: 'ARCHIVED' },
      cmsRepairNeededAt: null,
    });
  });

  it.each(['UNKNOWN_KEY', 'UNKNOWN_SITE'])('a site answering 401 %s flags re-pair needed (polling stops)', async (code) => {
    h.listError = new CmsBridgeError({ status: 401, code, message: 'no' });
    const r = await syncEmdashPipelines();
    expect(r.errors).toBe(1);
    expect(h.flagged).toHaveLength(1);
    expect(h.flagged[0].reason).toMatch(code);
  });

  it('other failures (timeouts) do not flag', async () => {
    h.listError = new CmsBridgeError({ status: 502, code: 'UPSTREAM_UNAVAILABLE', message: 'down', retryable: true });
    await syncEmdashPipelines();
    expect(h.flagged).toHaveLength(0);
  });
});

describe('events-replay import rules (issue 1, v1.0.4 §17a)', () => {
  it('ignores events at or below the starting cursor and events stamped for another siteId', async () => {
    h.replay = {
      ok: true,
      events: [
        { eventId: 'old1', cursor: 3, type: 'pipeline_submitted' },
        { eventId: 'edge', cursor: 21, type: 'pipeline_submitted' },
        { eventId: 'foreign', cursor: 22, siteId: 'site_previous01', type: 'pipeline_submitted' },
        { eventId: 'mine', cursor: 23, siteId: 'site_current01', type: 'pipeline_submitted' },
        { eventId: 'legacy', cursor: 24, type: 'pipeline_submitted' },
      ],
      lastCursor: 24,
      more: false,
    };
    await replayEmdashEvents('p1');
    expect(h.batches.flat().map((e) => e.eventId)).toEqual(['mine', 'legacy']);
  });
});
