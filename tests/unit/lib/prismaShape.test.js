/**
 * tests/helpers/prismaShape.js checks Prisma call arguments against the generated client's DMMF, so mocked unit tests
 * catch selects of fields that do not exist (release-3 e2e O-R3-1: uptime fleet selected ClientAccount.name).
 */
import { describe, it, expect } from 'vitest';
import { prismaShapeErrors, assertPrismaArgs, shapeChecked, takeShapeViolations } from '../../helpers/prismaShape.js';

describe('prismaShape', () => {
  it('rejects a nested select of a field the related model does not have (the fleet bug)', () => {
    const errs = prismaShapeErrors('project', 'findMany', { select: { id: true, client: { select: { name: true } } } });
    expect(errs).toEqual([expect.stringContaining("unknown field 'name' on model 'ClientAccount'")]);
    expect(() => assertPrismaArgs('project', 'findMany', { select: { client: { select: { name: true } } } })).toThrow(/Prisma shape check failed/);
    expect(takeShapeViolations()).toHaveLength(1);
    expect(prismaShapeErrors('project', 'findMany', { select: { id: true, name: true, client: { select: { agencyName: true } } } })).toEqual([]);
  });

  it('checks where (relation filters, compound unique keys, AND/OR), orderBy, data, groupBy and count', () => {
    expect(prismaShapeErrors('project', 'findMany', { where: { OR: [{ leadPmId: 'u' }, { client: { secondaryPmId: 'u' } }] } })).toEqual([]);
    expect(prismaShapeErrors('project', 'findMany', { where: { client: { nope: 1 } } })).toHaveLength(1);
    expect(prismaShapeErrors('securityAlertLog', 'findUnique', { where: { projectId_alertKey: { projectId: 'p', alertKey: 'k' } } })).toEqual([]);
    expect(prismaShapeErrors('uptimeDaily', 'findMany', { orderBy: { day: 'asc' } })).toHaveLength(1);
    expect(prismaShapeErrors('uptimeCheck', 'create', { data: { projectId: 'p', target: 'home', ok: true, bogus: 1 } })).toHaveLength(1);
    expect(prismaShapeErrors('uptimeCheck', 'groupBy', { by: ['projectId'], _max: { at: true } })).toEqual([]);
    expect(prismaShapeErrors('uptimeCheck', 'groupBy', { by: ['site'], _max: { when: true } })).toHaveLength(2);
    expect(prismaShapeErrors('pageSpeedDaily', 'upsert', { where: { projectId_date_strategy: {} }, create: { status: 'ok' }, update: { stat: 'x' } })).toHaveLength(1);
    expect(prismaShapeErrors('project', 'count', { where: { status: 'ACTIVE' } })).toEqual([]);
    expect(prismaShapeErrors('noSuchModel', 'findMany', {})).toHaveLength(1);
  });

  it('shapeChecked wraps a hand-written mock', async () => {
    const mock = shapeChecked({ project: { findMany: async () => [] }, $transaction: 1 });
    await expect(mock.project.findMany({ select: { id: true } })).resolves.toEqual([]);
    expect(() => mock.project.findMany({ select: { nope: true } })).toThrow(/unknown field 'nope'/);
    expect(mock.$transaction).toBe(1);
    takeShapeViolations();
  });
});
