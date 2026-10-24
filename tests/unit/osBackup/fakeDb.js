/**
 * In-memory stand-in for dbConn.dataAdapter: answers the exact queries the dump engine sends (SHOW FULL TABLES,
 * information_schema, SHOW CREATE, keyset SELECTs) from a fixture. Records every SQL string it was sent.
 */
export function fakeDataDb({ database = 'lw_test', tables = {}, views = {}, triggers = [], maxAllowedPacket = 64 * 1024 * 1024 } = {}) {
  const log = [];
  const parseLits = (s) =>
    (s.match(/'(?:[^'\\]|\\.)*'|X'[0-9a-f]*'|[^,()\s]+/gi) || []).map((t) => (t.startsWith("'") ? t.slice(1, -1).replace(/\\(.)/g, '$1') : /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t));
  const cmp = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
  const cmpTuple = (a, b) => {
    for (let i = 0; i < a.length; i += 1) {
      const c = cmp(a[i], b[i]);
      if (c) return c;
    }
    return 0;
  };
  const db = {
    log,
    async exec(sql) {
      log.push(sql);
      return { affectedRows: 0 };
    },
    async rows(sql, params = []) {
      log.push(sql);
      if (sql.startsWith('SELECT VERSION()')) return [{ version: '10.11.9-MariaDB', maxAllowedPacket, db: database }];
      if (sql === 'SHOW FULL TABLES') {
        return [
          ...Object.keys(tables).map((t) => ({ [`Tables_in_${database}`]: t, Table_type: 'BASE TABLE' })),
          ...Object.keys(views).map((v) => ({ [`Tables_in_${database}`]: v, Table_type: 'VIEW' })),
        ];
      }
      if (sql.includes('FROM information_schema.TABLES')) return Object.entries(tables).map(([name, t]) => ({ name, engine: t.engine || 'InnoDB', estRows: (t.rows || []).length }));
      if (sql.includes('FROM information_schema.COLUMNS')) return tables[params[1]].cols.map((c) => ({ name: c.name, dataType: c.dataType, extra: c.extra || '' }));
      if (sql.includes('FROM information_schema.STATISTICS')) {
        const t = tables[params[1]];
        const out = [];
        for (const [idx, def] of Object.entries(t.indexes || {})) def.cols.forEach((col, i) => out.push({ idx, col, seq: i + 1, nonUnique: def.unique ? 0 : 1, nullable: def.nullable ? 'YES' : '', subPart: null }));
        return out;
      }
      if (sql.includes('information_schema.ROUTINES') || sql.includes('information_schema.EVENTS')) return [{ n: 0 }];
      if (sql.includes('AS name FROM `_prisma_migrations`')) return [{ name: '20261110_ghl_forms' }, { name: '20261115_os_backups' }];
      let m = sql.match(/^SHOW CREATE TABLE `(.+)`$/);
      if (m) return [{ Table: m[1], 'Create Table': tables[m[1]].ddl || `CREATE TABLE \`${m[1]}\` (x int)` }];
      m = sql.match(/^SHOW CREATE VIEW `(.+)`$/);
      if (m) return [{ View: m[1], 'Create View': views[m[1]] }];
      if (sql === 'SHOW TRIGGERS') return triggers.map((t) => ({ Trigger: t.name, Table: t.table }));
      m = sql.match(/^SHOW CREATE TRIGGER `(.+)`$/);
      if (m) return [{ Trigger: m[1], 'SQL Original Statement': triggers.find((t) => t.name === m[1]).ddl }];
      m = sql.match(/^SELECT (.+) FROM `([^`]+)`(?: WHERE (.+?))? ORDER BY (.+) LIMIT (\d+)$/);
      if (m) {
        const t = tables[m[2]];
        const keys = m[4].split(',').map((k) => k.replace(/`/g, ''));
        let rows = [...t.rows].sort((a, b) => cmpTuple(keys.map((k) => a[k]), keys.map((k) => b[k])));
        if (m[3]) {
          const rhs = parseLits(m[3].split('>')[1]);
          rows = rows.filter((r) => cmpTuple(keys.map((k) => r[k]), rhs) > 0);
        }
        return rows.slice(0, Number(m[5]));
      }
      throw new Error(`fakeDb: unexpected SQL ${sql}`);
    },
    async *stream(sql) {
      log.push(sql);
      const m = sql.match(/FROM `([^`]+)`/);
      for (const r of tables[m[1]].rows) yield r;
    },
  };
  return db;
}
