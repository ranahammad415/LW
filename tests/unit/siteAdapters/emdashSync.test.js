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
  project: { id: 'p1', cmsSiteId: 'site_current01', cmsLastCursor: 21, wpUrl: 'https://s.example' },
  pages: [],
  pageUpdates: [],
  inventory: null,
  inventoryError: null,
  entryGets: [],
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
    wpPage: {
      findMany: async () => h.pages,
      create: async (args) => ({ id: 'new', ...args.data }),
      update: async (args) => {
        h.pageUpdates.push(args);
        return {};
      },
    },
    wpPageSnapshot: { create: async () => ({}) },
  },
}));
vi.mock('../../../src/lib/cmsKeyCrypto.js', async (orig) => ({ ...(await orig()), isCmsKeyCryptoConfigured: () => true }));
vi.mock('../../../src/lib/notificationService.js', () => ({ notify: vi.fn(async () => {}) }));
vi.mock('../../../src/lib/contentMapSync.js', () => ({ reconcileProjectMapsSafe: vi.fn(), mirrorPipelineToMaps: vi.fn(async () => {}) }));
vi.mock('../../../src/lib/cmsStore.js', () => ({
  loadEmdashConnection: async () => ({ project: h.project, conn: { siteUrl: 'https://s.example', siteId: 'site_current01', inbound: {} } }),
  mirrorEmdashReview: async () => null,
  backfillEmdashHistory: async () => 0,
  closeForeignReview: async () => true,
  prismaCmsStore: {
    flagRepairNeeded: async (pid, reason) => {
      h.flagged.push({ pid, reason });
      return true;
    },
    findCounterRegression: async () => null,
    setLastCursor: async () => {},
    recordHeartbeat: async () => {},
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
      siteInfo: async () => ({ ok: true, supportedContracts: [1], contract: 1 }),
      inventory: async () => {
        if (h.inventoryError) throw h.inventoryError;
        return h.inventory;
      },
      entryGet: async (conn, entryId, variant) => {
        h.entryGets.push({ entryId, variant });
        return { ok: true, entry: { outline: { headings: [{ level: 1, text: 'H' }], internalLinks: ['/x/'], externalLinkCount: 0, imageCount: 0 }, outlineHash: `h-${entryId}` } };
      },
    },
  };
});

vi.mock('../../../src/lib/wpSync.js', () => ({ autoSyncSitemap: vi.fn(async () => ({})) }));

import { syncEmdashPipelines, replayEmdashEvents, syncEmdashInventory, scheduleInventoryAfterPairing } from '../../../src/lib/emdashSync.js';
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

describe('inventory: omitted outlines (v1.0.6 size guard)', () => {
  it('fetches at most 25 changed outlines per run via entry-get; unchanged hashes are skipped', async () => {
    h.entryGets = [];
    h.pageUpdates = [];
    const item = (n) => ({ entryId: `E${n}`, entryNo: n, collection: 'pages', slug: `s${n}`, path: `/s${n}/`, title: `T${n}`, status: 'published', hasPendingDraft: false, draftRevisionId: null, liveRevisionId: 'L', contentHash: 'a'.repeat(64), updatedAt: '2026-10-15T12:00:00Z', outlineOmitted: true, outlineHash: `hash-${n}` });
    h.inventory = { ok: true, items: Array.from({ length: 30 }, (_, i) => item(i + 1)), next: null };
    h.pages = [{ id: 'p-1', wpPostId: 1, contentHash: 'a'.repeat(64), content: '', status: 'published', cmsOutlineHash: 'hash-1' }];
    const r = await syncEmdashInventory('p1');
    expect(h.entryGets).toHaveLength(25);
    expect(h.entryGets.map((g) => g.entryId)).not.toContain('E1');
    expect(h.entryGets[0].variant).toBe('live');
    expect(r).toMatchObject({ synced: 30, outlinesFetched: 25, outlinesDeferred: 4 });
    const outlineWrites = h.pageUpdates.filter((u) => u.data.cmsOutline);
    expect(outlineWrites).toHaveLength(25);
    expect(outlineWrites[0].data.cmsOutlineHash).toBe('h-E2');
  });
});

describe('first inventory after pairing (item 2)', () => {
  it('runs once after the delay, time-boxed, and a 401 there never flags re-pair', async () => {
    vi.useFakeTimers();
    try {
      h.flagged = [];
      h.inventoryError = new CmsBridgeError({ status: 401, code: 'UNKNOWN_KEY', message: 'keys not installed yet' });
      const log = { info: vi.fn(), warn: vi.fn() };
      scheduleInventoryAfterPairing('p1', log);
      await vi.advanceTimersByTimeAsync(14_000);
      expect(log.info).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.runAllTimersAsync();
      expect(log.info).toHaveBeenCalledTimes(1);
      expect(log.info.mock.calls[0][0].result.error).toMatch(/keys not installed/);
      expect(h.flagged).toHaveLength(0);
    } finally {
      h.inventoryError = null;
      vi.useRealTimers();
    }
  });
});
