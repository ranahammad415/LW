/**
 * Pure-Node dump engine (plan b.2): one connection, one consistent snapshot, keyset-paged reads, JSON Lines records.
 * `db` is the adapter from dbConn.dataAdapter (rows / exec / stream); `emit(record)` is awaited for backpressure.
 * Records: begin, table (DDL + columns), rows (one INSERT), tableEnd (row count + sha256 of the INSERT strings),
 * view, trigger, end. No value is ever logged; progress reports carry table names and counts only.
 */
import crypto from 'crypto';
import { PAYLOAD_FORMAT, PRESERVED_TABLES } from './config.js';
import { InsertBatcher, columnKind, encodeValue, normalizeViewDdl, quoteId, rowTuple, statementLimits, stripDefiner } from './sqlWriter.js';
import { LwosError } from './dbConn.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE_BYTES_SOFT = 8 * 1024 * 1024;

/** Start the snapshot. Every following SELECT on this connection sees the same data. */
export async function beginSnapshot(db) {
  await db.exec('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await db.exec('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
}

export async function serverFacts(db) {
  const [v] = await db.rows('SELECT VERSION() AS version, @@max_allowed_packet AS maxAllowedPacket, DATABASE() AS db');
  return { version: String(v?.version || ''), maxAllowedPacket: Number(v?.maxAllowedPacket) || 4 * 1024 * 1024, database: String(v?.db || '') };
}

export async function listInventory(db, database) {
  const full = await db.rows('SHOW FULL TABLES');
  const items = full.map((r) => {
    const vals = Object.values(r);
    return { name: String(vals[0]), type: String(vals[1] || 'BASE TABLE').toUpperCase() };
  });
  const info = await db.rows('SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_ROWS AS estRows FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [database]);
  const byName = new Map(info.map((r) => [String(r.name), r]));
  const tables = items
    .filter((i) => i.type === 'BASE TABLE' && !PRESERVED_TABLES.includes(i.name))
    .map((i) => ({ name: i.name, engine: byName.get(i.name)?.engine || null, estRows: Number(byName.get(i.name)?.estRows) || 0 }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const views = items.filter((i) => i.type === 'VIEW').map((i) => i.name).sort();
  return { tables, views };
}

export async function tableColumns(db, database, table) {
  const rows = await db.rows(
    'SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [database, table]
  );
  const cols = rows.filter((c) => !/GENERATED/i.test(String(c.extra || '')));
  return { cols: cols.map((c) => String(c.name)), kinds: cols.map((c) => columnKind(c.dataType)), allKinds: new Map(rows.map((c) => [String(c.name), columnKind(c.dataType)])) };
}

/** PRIMARY, else the first unique index whose columns are all NOT NULL and not prefixes. Null = stream the table. */
export async function keyColumns(db, database, table) {
  const rows = await db.rows(
    'SELECT INDEX_NAME AS idx, COLUMN_NAME AS col, SEQ_IN_INDEX AS seq, NON_UNIQUE AS nonUnique, NULLABLE AS nullable, SUB_PART AS subPart FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX',
    [database, table]
  );
  const byIdx = new Map();
  for (const r of rows) {
    const k = String(r.idx);
    if (!byIdx.has(k)) byIdx.set(k, []);
    byIdx.get(k).push(r);
  }
  const usable = (list) => list.every((r) => Number(r.nonUnique) === 0 && String(r.nullable || '') !== 'YES' && (r.subPart === null || r.subPart === undefined));
  if (byIdx.has('PRIMARY') && usable(byIdx.get('PRIMARY'))) return byIdx.get('PRIMARY').map((r) => String(r.col));
  const names = [...byIdx.keys()].filter((k) => k !== 'PRIMARY').sort();
  for (const n of names) if (usable(byIdx.get(n))) return byIdx.get(n).map((r) => String(r.col));
  return null;
}

function keyWhere(keyCols, kinds, last) {
  const lit = keyCols.map((c, i) => encodeValue(last[c], kinds[i]));
  if (keyCols.length === 1) return `${quoteId(keyCols[0])} > ${lit[0]}`;
  return `(${keyCols.map(quoteId).join(',')}) > (${lit.join(',')})`;
}

/**
 * Dump every table (DDL + rows), then views and triggers. Returns the manifest facts.
 * opts: { database, server, pageRows, pageDelayMs, excludeData[], deadline (ms epoch), onProgress(p), shouldAbort() }
 */
export async function dumpDatabase(db, emit, opts) {
  const { database, server = {}, pageRows = 2000, pageDelayMs = 5, excludeData = [], deadline = Infinity, onProgress = () => {}, shouldAbort = () => false } = opts;
  const { cap, hardMax } = statementLimits(server.maxAllowedPacket);
  const warnings = [];
  const check = () => {
    if (shouldAbort()) throw new LwosError('ABORTED', 'Backup was stopped');
    if (Date.now() > deadline) throw new LwosError('TIMEOUT', 'Backup ran past OS_BACKUP_MAX_MINUTES');
  };

  await emit({ k: 'begin', format: PAYLOAD_FORMAT, db: database, server: server.version || '', at: new Date().toISOString() });
  const { tables, views } = await listInventory(db, database);
  const out = [];
  let totalRows = 0;

  for (let ti = 0; ti < tables.length; ti += 1) {
    check();
    const t = tables[ti];
    if (t.engine && String(t.engine).toLowerCase() !== 'innodb') warnings.push(`Table ${t.name} uses ${t.engine}: outside the consistent snapshot`);
    const [ddlRow] = await db.rows(`SHOW CREATE TABLE ${quoteId(t.name)}`);
    const ddl = String(ddlRow?.['Create Table'] ?? Object.values(ddlRow || {})[1] ?? '');
    const { cols, kinds, allKinds } = await tableColumns(db, database, t.name);
    await emit({ k: 'table', t: t.name, ddl, cols, estRows: t.estRows });
    const sha = crypto.createHash('sha256');
    let rows = 0;
    const excluded = excludeData.includes(t.name);
    onProgress({ phase: 'DUMP', table: t.name, tableIndex: ti + 1, tableCount: tables.length, rows: totalRows });

    if (!excluded && cols.length) {
      const batcher = new InsertBatcher(t.name, cols, { cap, hardMax });
      const push = async (stmt) => {
        if (!stmt) return;
        sha.update(stmt.sql).update('\n');
        await emit({ k: 'rows', t: t.name, n: stmt.n, sql: stmt.sql });
      };
      const keys = await keyColumns(db, database, t.name);
      const select = `SELECT ${cols.map(quoteId).join(',')} FROM ${quoteId(t.name)}`;
      if (keys && keys.every((k) => cols.includes(k) || allKinds.has(k))) {
        const keyKinds = keys.map((k) => allKinds.get(k) || 'str');
        const extraKeys = keys.filter((k) => !cols.includes(k)); // a generated column in the key (unusual)
        const sel = extraKeys.length ? `SELECT ${[...cols, ...extraKeys].map(quoteId).join(',')} FROM ${quoteId(t.name)}` : select;
        let n = pageRows;
        let last = null;
        for (;;) {
          check();
          const where = last ? ` WHERE ${keyWhere(keys, keyKinds, last)}` : '';
          const page = await db.rows(`${sel}${where} ORDER BY ${keys.map(quoteId).join(',')} LIMIT ${n}`);
          let pageBytes = 0;
          for (const r of page) {
            const tuple = rowTuple(r, cols, kinds);
            pageBytes += tuple.length;
            await push(batcher.add(tuple, keys.map((k) => String(r[k] ?? '').slice(0, 64)).join(',')));
            rows += 1;
          }
          if (page.length < n) break;
          last = page[page.length - 1];
          if (pageBytes > PAGE_BYTES_SOFT) n = Math.max(50, Math.floor(n / 2));
          else if (n < pageRows && pageBytes < PAGE_BYTES_SOFT / 4) n = Math.min(pageRows, n * 2);
          onProgress({ phase: 'DUMP', table: t.name, tableIndex: ti + 1, tableCount: tables.length, rows: totalRows + rows });
          if (pageDelayMs) await sleep(pageDelayMs);
        }
      } else {
        for await (const r of db.stream(select)) {
          await push(batcher.add(rowTuple(r, cols, kinds)));
          rows += 1;
          if (rows % 5000 === 0) check();
        }
      }
      await push(batcher.flush());
    }
    const tableSha = sha.digest('hex');
    await emit({ k: 'tableEnd', t: t.name, rows, sha256: tableSha });
    out.push({ name: t.name, rows, sha256: tableSha, engine: t.engine || null, ...(excluded ? { dataExcluded: true } : {}) });
    totalRows += rows;
  }

  const viewOut = [];
  for (const v of views) {
    check();
    const [r] = await db.rows(`SHOW CREATE VIEW ${quoteId(v)}`);
    const ddl = normalizeViewDdl(String(r?.['Create View'] ?? Object.values(r || {})[1] ?? ''));
    await emit({ k: 'view', name: v, ddl });
    viewOut.push(v);
  }

  const trigOut = [];
  const trigs = await db.rows('SHOW TRIGGERS');
  for (const tr of trigs) {
    const name = String(tr.Trigger ?? Object.values(tr)[0]);
    const [r] = await db.rows(`SHOW CREATE TRIGGER ${quoteId(name)}`);
    const ddl = stripDefiner(String(r?.['SQL Original Statement'] ?? ''));
    if (!ddl) continue;
    await emit({ k: 'trigger', name, table: String(tr.Table || ''), ddl });
    trigOut.push(name);
  }

  try {
    const [rc] = await db.rows('SELECT COUNT(*) AS n FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?', [database]);
    const [ec] = await db.rows('SELECT COUNT(*) AS n FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?', [database]);
    if (Number(rc?.n) > 0) warnings.push(`${Number(rc.n)} stored routine(s) are not backed up`);
    if (Number(ec?.n) > 0) warnings.push(`${Number(ec.n)} event(s) are not backed up`);
  } catch {
    /* information_schema access is best effort */
  }

  await emit({ k: 'end', tables: out.length, rows: totalRows });
  return { tables: out, views: viewOut, triggers: trigOut, warnings, totalRows };
}
