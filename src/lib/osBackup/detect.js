/**
 * Detection (plan b.1): binaries, server facts, grants, GET_LOCK, engines, the largest tables, disk and directory.
 * Read-only on the DB. The mysqldump dry run is part of P7 and is not run here; only `--version` is probed, so no
 * credential ever reaches a child process. Result goes to osbackupstate.detectJson and the CLI prints it.
 */
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { BACKEND_ROOT } from './config.js';
import { statDir } from './disk.js';

function probe(bin, args = ['--version'], timeout = 5000) {
  return new Promise((resolve) => {
    try {
      execFile(bin, args, { timeout, windowsHide: true }, (err, stdout) => {
        if (err) {
          const blocked = err.code === 'EACCES' || err.code === 'EPERM';
          resolve({ ok: false, error: err.code === 'ENOENT' ? 'not found' : blocked ? 'exec blocked' : String(err.code || 'error'), blocked });
        } else resolve({ ok: true, version: String(stdout).trim().slice(0, 200) });
      });
    } catch (err) {
      resolve({ ok: false, error: String(err?.code || 'spawn failed'), blocked: true });
    }
  });
}

export async function detectBinaries(cfg) {
  const candidates = [...new Set([cfg.mysqldumpPath, 'mysqldump', '/usr/bin/mysqldump'])];
  let mysqldump = { ok: false, error: 'not found' };
  for (const c of candidates) {
    mysqldump = { path: c, ...(await probe(c)) };
    if (mysqldump.ok) break;
  }
  const mysqlBin = { path: cfg.mysqlPath, ...(await probe(cfg.mysqlPath)) };
  const flavour = /mariadb/i.test(mysqldump.version || mysqlBin.version || '') ? 'mariadb' : mysqldump.ok || mysqlBin.ok ? 'mysql' : null;
  const exec = mysqldump.blocked || mysqlBin.blocked ? 'blocked' : 'allowed';
  return { mysqldump, mysql: mysqlBin, flavour, exec };
}

export async function detectServer(data) {
  const out = {};
  const [v] = await data.rows(
    'SELECT VERSION() AS version, @@version_comment AS comment, @@max_allowed_packet AS maxAllowedPacket, @@max_user_connections AS maxUserConnections, @@lower_case_table_names AS lowerCaseTableNames, @@sql_mode AS sqlMode, @@innodb_version AS innodbVersion, DATABASE() AS db'
  );
  Object.assign(out, {
    version: String(v.version),
    comment: String(v.comment || ''),
    maxAllowedPacket: Number(v.maxAllowedPacket),
    maxUserConnections: Number(v.maxUserConnections),
    lowerCaseTableNames: Number(v.lowerCaseTableNames),
    sqlMode: String(v.sqlMode || ''),
    innodbVersion: v.innodbVersion ? String(v.innodbVersion) : null,
    database: String(v.db || ''),
  });
  try {
    const grants = (await data.rows('SHOW GRANTS')).map((r) => String(Object.values(r)[0]));
    const all = grants.join(' ').toUpperCase();
    out.grants = Object.fromEntries(['TRIGGER', 'CREATE VIEW', 'SHOW VIEW', 'LOCK TABLES', 'EVENT', 'DROP', 'CREATE', 'ALTER', 'PROCESS'].map((g) => [g, all.includes('ALL PRIVILEGES') || all.includes(g)]));
  } catch {
    out.grants = null;
  }
  try {
    const [l] = await data.rows("SELECT GET_LOCK('lwos_probe', 0) AS l");
    out.getLock = Number(l?.l) === 1;
    await data.rows("SELECT RELEASE_LOCK('lwos_probe') AS r");
  } catch {
    out.getLock = false;
  }
  const tables = await data.rows(
    'SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_ROWS AS estRows, DATA_LENGTH + INDEX_LENGTH AS bytes, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
    [out.database]
  );
  const base = tables.filter((t) => String(t.type) === 'BASE TABLE');
  out.tableCount = base.length;
  out.viewCount = tables.length - base.length;
  out.totalBytes = base.reduce((a, t) => a + (Number(t.bytes) || 0), 0);
  out.nonInnoDb = base.filter((t) => String(t.engine || '').toLowerCase() !== 'innodb').map((t) => `${t.name} (${t.engine})`);
  out.largest = [...base]
    .sort((a, b) => (Number(b.bytes) || 0) - (Number(a.bytes) || 0))
    .slice(0, 15)
    .map((t) => ({ name: String(t.name), bytes: Number(t.bytes) || 0, estRows: Number(t.estRows) || 0 }));
  const count = async (sql) => {
    try {
      const [r] = await data.rows(sql, [out.database]);
      return Number(r?.n) || 0;
    } catch {
      return null;
    }
  };
  out.triggers = await count('SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?');
  out.routines = await count('SELECT COUNT(*) AS n FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?');
  out.events = await count('SELECT COUNT(*) AS n FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?');
  return out;
}

/** Directory rules: mode 0700, owned by us, outside the app dir, writable (write + fsync + rename). */
export async function detectDir(cfg) {
  const res = { dir: cfg.dir, exists: false, mode: null, ownerOk: null, outsideApp: !cfg.dirInsideApp, writable: false, problems: [] };
  try {
    const st = fs.statSync(cfg.dir);
    res.exists = st.isDirectory();
    res.mode = (st.mode & 0o777).toString(8);
    if (typeof process.getuid === 'function') res.ownerOk = st.uid === process.getuid();
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) res.problems.push(`mode is ${res.mode}, must be 700`);
    if (res.ownerOk === false) res.problems.push('directory is owned by another user');
  } catch {
    res.problems.push('directory does not exist (mkdir -p ~/os-backups && chmod 700 ~/os-backups)');
    return res;
  }
  if (!res.outsideApp) res.problems.push(`directory is inside the app directory (${BACKEND_ROOT})`);
  const probeFile = path.join(cfg.dir, `.probe-${process.pid}`);
  try {
    const fh = await fs.promises.open(probeFile, 'w', 0o600);
    await fh.writeFile('ok');
    await fh.sync();
    await fh.close();
    await fs.promises.rename(probeFile, `${probeFile}.r`);
    await fs.promises.unlink(`${probeFile}.r`);
    res.writable = true;
  } catch {
    res.problems.push('directory is not writable');
    await fs.promises.unlink(probeFile).catch(() => {});
  }
  res.disk = await statDir(cfg.dir);
  return res;
}

export async function detect({ cfg, data }) {
  const at = new Date().toISOString();
  const [binaries, dir] = await Promise.all([detectBinaries(cfg), detectDir(cfg)]);
  let server = null;
  let serverError = null;
  if (data) {
    try {
      server = await detectServer(data);
    } catch (err) {
      serverError = String(err?.code || 'ERROR');
    }
  }
  return {
    at,
    engine: { configured: cfg.engineRequested, used: 'node', mysqldumpEngineBuilt: false },
    binaries,
    server,
    serverError,
    dir,
    key: { ok: cfg.keyOk, error: cfg.keyError },
  };
}
