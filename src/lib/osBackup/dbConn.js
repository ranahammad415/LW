/**
 * mysql2 connections for the backup engine (plan b.2). Not Prisma: interactive transactions time out after 5 s and
 * $queryRaw buffers whole result sets. Two kinds:
 *   data    → dumps / restores: utf8mb4, dateStrings (no timezone shift), big numbers as strings, JSON as raw text,
 *             BLOB / BINARY / BIT as Buffer, one statement per query.
 *   control → the four preserved tables, GET_LOCK, heartbeats (normal JS types, UTC dates).
 * Credentials come from DATABASE_URL; the Prisma-only query parameters are dropped. Nothing here logs a value.
 */
import mysql from 'mysql2/promise';

const PRISMA_ONLY = new Set(['connection_limit', 'pool_timeout', 'connect_timeout', 'sslaccept', 'schema', 'socket_timeout', 'sslcert', 'sslidentity', 'sslpassword', 'statement_cache_size', 'socket']);

export function parseDatabaseUrl(url) {
  if (!url) {
    const e = new Error('DATABASE_URL is not set');
    e.code = 'NO_DATABASE_URL';
    e.safe = true;
    throw e;
  }
  const u = new URL(url);
  if (u.protocol !== 'mysql:') {
    const e = new Error('DATABASE_URL is not a mysql:// URL');
    e.code = 'BAD_DATABASE_URL';
    e.safe = true;
    throw e;
  }
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  const out = {
    host: u.hostname || 'localhost',
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
    database,
  };
  const socket = u.searchParams.get('socket');
  if (socket) out.socketPath = socket;
  const sslaccept = u.searchParams.get('sslaccept');
  if (sslaccept === 'strict') out.ssl = { rejectUnauthorized: true };
  else if (sslaccept === 'accept_invalid_certs') out.ssl = { rejectUnauthorized: false };
  out.ignoredParams = [...u.searchParams.keys()].filter((k) => PRISMA_ONLY.has(k));
  return out;
}

function jsonAsText(field, next) {
  if (field.type === 'JSON') return field.string('utf8');
  return next();
}

export async function openDataConnection(databaseUrl, extra = {}) {
  const { ignoredParams, ...c } = parseDatabaseUrl(databaseUrl);
  const conn = await mysql.createConnection({
    ...c,
    charset: 'UTF8MB4_UNICODE_CI',
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    multipleStatements: false,
    timezone: 'Z',
    typeCast: jsonAsText,
    connectTimeout: 20_000,
    ...extra,
  });
  await conn.query("SET SESSION time_zone = '+00:00'");
  for (const s of ['SET SESSION net_read_timeout = 600', 'SET SESSION net_write_timeout = 600']) {
    await conn.query(s).catch(() => {});
  }
  return conn;
}

export async function openControlConnection(databaseUrl) {
  const { ignoredParams, ...c } = parseDatabaseUrl(databaseUrl);
  const conn = await mysql.createConnection({
    ...c,
    charset: 'UTF8MB4_UNICODE_CI',
    supportBigNumbers: true,
    bigNumberStrings: false,
    multipleStatements: false,
    timezone: 'Z',
    connectTimeout: 20_000,
  });
  await conn.query("SET SESSION time_zone = '+00:00'");
  return conn;
}

/** Thin adapter the engine uses (the unit tests fake it): rows / exec / stream / id. */
export function dataAdapter(conn) {
  return {
    async rows(sql, params) {
      const [rows] = await conn.query(sql, params);
      return rows;
    },
    async exec(sql, params) {
      const [res] = await conn.query(sql, params);
      return res;
    },
    async *stream(sql, params) {
      // Underlying callback connection: a streamed SELECT with backpressure (tables without a usable key).
      const s = conn.connection.query(sql, params).stream({ highWaterMark: 256 });
      for await (const row of s) yield row;
    },
    threadId: conn.threadId ?? conn.connection?.threadId,
    end: () => conn.end().catch(() => {}),
    destroy: () => {
      try {
        conn.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Sanitized DB / engine error for logs, the journal, job files and `error` columns (plan f.8): code, errno, sqlState
 * and the table only. Never err.message from the driver ("Duplicate entry 'x@y.com'..."). Our own errors carry
 * `safe: true` and a message written without data.
 */
export function sanitizeError(err, table) {
  if (!err) return 'ERROR';
  if (err.safe && err.message) return String(`${err.code ? `${err.code}: ` : ''}${err.message}`).slice(0, 500);
  const parts = [String(err.code || err.name || 'ERROR')];
  if (err.errno) parts.push(`errno=${err.errno}`);
  if (err.sqlState) parts.push(`sqlState=${err.sqlState}`);
  const t = table || err.lwosTable;
  if (t) parts.push(`table=${t}`);
  return parts.join(' ').slice(0, 500);
}

export class LwosError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.safe = true;
  }
}
