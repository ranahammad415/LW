/** e2e O22: /api/realtime/:projectId answered 500 for every PM (it selected Project.secondaryPmId, which does not exist). */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ project: null, link: null, lastSelect: null }));
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    project: {
      findUnique: async (args) => {
        db.lastSelect = args.select;
        // Prisma refuses unknown fields: model that here.
        if (args.select && 'secondaryPmId' in args.select) throw new Error('Unknown field `secondaryPmId` for select statement on model `Project`');
        return db.project;
      },
    },
    clientUser: { findFirst: async () => db.link },
  },
}));
vi.mock('../../src/lib/realtimeBus.js', () => ({ subscribe: () => () => {} }));

import { userCanAccessProject } from '../../src/routes/realtime.js';

beforeEach(() => {
  db.project = { id: 'p1', clientId: 'c1', leadPmId: 'pm-lead', client: { leadPmId: 'pm-client', secondaryPmId: 'pm-second' } };
  db.link = null;
});

describe('realtime project access', () => {
  it('PMs: project lead, client lead and client secondary PM; nobody else (no throw)', async () => {
    for (const id of ['pm-lead', 'pm-client', 'pm-second']) expect(await userCanAccessProject({ id, role: 'PM' }, 'p1')).toBe(true);
    expect(await userCanAccessProject({ id: 'pm-x', role: 'PM' }, 'p1')).toBe(false);
    expect(db.lastSelect).not.toHaveProperty('secondaryPmId');
  });

  it('OWNER always; CLIENT only through its client account; unknown project false', async () => {
    expect(await userCanAccessProject({ id: 'o', role: 'OWNER' }, 'p1')).toBe(true);
    expect(await userCanAccessProject({ id: 'cu', role: 'CLIENT' }, 'p1')).toBe(false);
    db.link = { id: 'l1' };
    expect(await userCanAccessProject({ id: 'cu', role: 'CLIENT' }, 'p1')).toBe(true);
    db.project = null;
    expect(await userCanAccessProject({ id: 'pm-lead', role: 'PM' }, 'p1')).toBe(false);
  });
});
