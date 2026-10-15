/** Review C4: client-portal EmDash pulls are throttled (60 s per project) and fail fast. */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: { project: { findUnique: async () => ({ cmsType: 'EMDASH' }), findMany: async () => [] } },
}));
const sync = vi.hoisted(() => ({ calls: [] }));
vi.mock('../../../src/lib/emdashSync.js', () => ({
  syncEmdashPipelines: async (args) => {
    sync.calls.push(args);
    return { synced: 1, errors: 0 };
  },
}));
vi.mock('../../../src/lib/contentMapSync.js', () => ({ mirrorPipelineToMaps: async () => {} }));

import { syncClientProjectsFromWp, syncPipelineFromWp } from '../../../src/lib/pipelineSync.js';

describe('client-portal EmDash pull', () => {
  it('runs at most once per minute per project, without retries; PM refresh is not throttled', async () => {
    await syncClientProjectsFromWp(['p-1']);
    await syncClientProjectsFromWp(['p-1']);
    expect(sync.calls).toHaveLength(1);
    expect(sync.calls[0]).toMatchObject({ projectId: 'p-1', noRetry: true });
    await syncPipelineFromWp({ projectId: 'p-1' });
    expect(sync.calls).toHaveLength(2);
    expect(sync.calls[1].noRetry).toBe(false);
  });
});
