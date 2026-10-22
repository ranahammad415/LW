import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ calls: [] }));
vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: {
    clientAccount: { findMany: async () => [{ id: 'c1', onboardingStatus: 'COMPLETE' }, { id: 'c2', onboardingStatus: 'IN_PROGRESS' }] },
    project: { findMany: async () => [{ id: 'p1', clientId: 'c1' }, { id: 'p2', clientId: 'c1' }, { id: 'p3', clientId: 'c2' }] },
    task: {
      groupBy: async (args) => {
        db.calls.push(args);
        if (args.where.dueDate) return [{ projectId: 'p1', _count: { _all: 2 } }, { projectId: 'p2', _count: { _all: 1 } }];
        return [{ projectId: 'p3', _count: { _all: 3 } }];
      },
    },
  },
}));

import { deliveryScore, computeDeliveryHealthMany, computeDeliveryHealth } from '../../../src/lib/health/deliveryHealth.js';

beforeEach(() => { db.calls = []; });

describe('deliveryHealth', () => {
  it('same formula as the old calculate-health route', () => {
    expect(deliveryScore({ overdue: 0, stagnant: 0, onboardingDone: true })).toBe(100);
    expect(deliveryScore({ overdue: 2, stagnant: 1, onboardingDone: false })).toBe(100 - 20 - 5 - 15);
    expect(deliveryScore({ overdue: 20, stagnant: 0, onboardingDone: true })).toBe(0);
  });

  it('batched: two groupBy calls for any number of clients; CANCELLED excluded from overdue', async () => {
    const m = await computeDeliveryHealthMany(['c1', 'c2']);
    expect(m.get('c1')).toEqual({ score: 70, overdue: 3, stagnant: 0, onboardingDone: true });
    expect(m.get('c2')).toEqual({ score: 100 - 15 - 15, overdue: 0, stagnant: 3, onboardingDone: false });
    expect(db.calls).toHaveLength(2);
    expect(db.calls[0].where.status.notIn).toEqual(['COMPLETED', 'CANCELLED']);
    expect(db.calls[1].where.status.in).toEqual(['IN_PROGRESS', 'NEEDS_REVIEW']);
  });

  it('single client helper', async () => {
    expect((await computeDeliveryHealth('c1')).score).toBe(70);
  });
});
