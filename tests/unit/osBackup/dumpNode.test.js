import { describe, it, expect } from 'vitest';
import { dumpDatabase } from '../../../src/lib/osBackup/dumpNode.js';
import { fakeDataDb } from './fakeDb.js';

const users = Array.from({ length: 7 }, (_, i) => ({ id: `u${i}`, email: `e${i}@x.io`, n: String(i) }));
const assignees = [];
for (const a of ['t1', 't2', 't3']) for (const b of ['u1', 'u2']) assignees.push({ A: a, B: b });

function fixture() {
  return fakeDataDb({
    tables: {
      user: {
        cols: [
          { name: 'id', dataType: 'varchar' },
          { name: 'email', dataType: 'varchar' },
          { name: 'n', dataType: 'bigint' },
          { name: 'full', dataType: 'varchar', extra: 'VIRTUAL GENERATED' },
        ],
        indexes: { PRIMARY: { unique: true, cols: ['id'] } },
        rows: users,
      },
      _TaskAssignees: {
        cols: [
          { name: 'A', dataType: 'varchar' },
          { name: 'B', dataType: 'varchar' },
        ],
        indexes: { _TaskAssignees_AB_unique: { unique: true, cols: ['A', 'B'] }, _TaskAssignees_B_index: { unique: false, cols: ['B'] } },
        rows: assignees,
      },
      nokey: {
        cols: [{ name: 'v', dataType: 'text' }],
        indexes: { maybe: { unique: true, nullable: true, cols: ['v'] } },
        rows: [{ v: 'a' }, { v: null }, { v: 'a' }],
      },
      osbackup: { cols: [{ name: 'id', dataType: 'varchar' }], rows: [{ id: 'never' }] },
      osbackupstate: { cols: [{ name: 'id', dataType: 'int' }], rows: [{ id: 1 }] },
      signalevent: { engine: 'MyISAM', cols: [{ name: 'id', dataType: 'int' }], indexes: { PRIMARY: { unique: true, cols: ['id'] } }, rows: [{ id: 1 }] },
    },
    views: { v_open: 'CREATE ALGORITHM=UNDEFINED DEFINER=`u1`@`localhost` SQL SECURITY DEFINER VIEW `v_open` AS select 1 AS `x`' },
    triggers: [{ name: 'trg', table: 'user', ddl: 'CREATE DEFINER=`u1`@`localhost` TRIGGER `trg` BEFORE INSERT ON `user` FOR EACH ROW SET NEW.n = 1' }],
  });
}

async function dump(db, opts = {}) {
  const records = [];
  const res = await dumpDatabase(db, async (r) => records.push(r), { database: 'lw_test', server: { maxAllowedPacket: 64 * 1024 * 1024 }, pageRows: 3, pageDelayMs: 0, ...opts });
  return { records, res };
}

describe('osBackup dumpNode (fake connection)', () => {
  it('keyset pages a single key; every row once, in order', async () => {
    const db = fixture();
    const { records, res } = await dump(db);
    const userRows = records.filter((r) => r.k === 'rows' && r.t === 'user');
    expect(userRows.reduce((a, r) => a + r.n, 0)).toBe(7);
    expect(res.tables.find((t) => t.name === 'user').rows).toBe(7);
    const pageQueries = db.log.filter((s) => s.startsWith('SELECT `id`,`email`,`n` FROM `user`'));
    expect(pageQueries).toHaveLength(3); // 3 + 3 + 1
    expect(pageQueries[1]).toContain("WHERE `id` > 'u2'");
    expect(pageQueries[2]).toContain("WHERE `id` > 'u5'");
    // bigint string stays unquoted
    expect(userRows[0].sql).toContain("('u0','e0@x.io',0)");
  });

  it('composite keys use a row constructor', async () => {
    const db = fixture();
    const { res } = await dump(db);
    expect(res.tables.find((t) => t.name === '_TaskAssignees').rows).toBe(6);
    expect(db.log.some((s) => s.includes("WHERE (`A`,`B`) > ('t2','u1')"))).toBe(true);
  });

  it('a table with no usable key is streamed (nullable unique index is not a key)', async () => {
    const db = fixture();
    const { res } = await dump(db);
    expect(res.tables.find((t) => t.name === 'nokey').rows).toBe(3);
    expect(db.log).toContain('SELECT `v` FROM `nokey`');
  });

  it('generated columns are skipped', async () => {
    const { records } = await dump(fixture());
    const t = records.find((r) => r.k === 'table' && r.t === 'user');
    expect(t.cols).toEqual(['id', 'email', 'n']);
  });

  it('preserved tables are never dumped', async () => {
    const { records, res } = await dump(fixture());
    expect(records.some((r) => r.t === 'osbackup' || r.t === 'osbackupstate')).toBe(false);
    expect(res.tables.map((t) => t.name)).not.toContain('osbackup');
  });

  it('definer removed from views and triggers; non-InnoDB warned', async () => {
    const { records, res } = await dump(fixture());
    const v = records.find((r) => r.k === 'view');
    expect(v.ddl).not.toMatch(/DEFINER=/);
    expect(v.ddl).toContain('SQL SECURITY INVOKER');
    const tr = records.find((r) => r.k === 'trigger');
    expect(tr.ddl).toBe('CREATE TRIGGER `trg` BEFORE INSERT ON `user` FOR EACH ROW SET NEW.n = 1');
    expect(res.warnings.some((w) => w.includes('signalevent') && w.includes('MyISAM'))).toBe(true);
  });

  it('record order: begin, tables with tableEnd, views, triggers, end', async () => {
    const { records, res } = await dump(fixture());
    expect(records[0].k).toBe('begin');
    expect(records[records.length - 1]).toEqual({ k: 'end', tables: res.tables.length, rows: res.totalRows });
    const kinds = records.map((r) => r.k);
    expect(kinds.lastIndexOf('tableEnd')).toBeLessThan(kinds.indexOf('view'));
    expect(kinds.indexOf('view')).toBeLessThan(kinds.indexOf('trigger'));
  });

  it('excluded data tables keep their DDL but no rows', async () => {
    const { records, res } = await dump(fixture(), { excludeData: ['user'] });
    expect(records.some((r) => r.k === 'table' && r.t === 'user')).toBe(true);
    expect(records.some((r) => r.k === 'rows' && r.t === 'user')).toBe(false);
    expect(res.tables.find((t) => t.name === 'user')).toMatchObject({ rows: 0, dataExcluded: true });
  });

  it('stops on the deadline', async () => {
    await expect(dump(fixture(), { deadline: Date.now() - 1 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
