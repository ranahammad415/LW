/**
 * SQL value encoding + INSERT batching for the Node dump engine (plan b.2).
 * Column kinds come from information_schema.COLUMNS.DATA_TYPE (columnKind):
 *   num  → integers / decimals / floats (strings from bigNumberStrings stay unquoted, after a strict numeric check)
 *   bin  → BLOB / BINARY / VARBINARY / BIT (Buffer → X'hex')
 *   json → raw utf8 text from the typeCast (quoted, byte-for-byte)
 *   str  → everything else, dates included (dateStrings: no timezone shift)
 * Strings are escaped with mysql2's escape (\0 \b \t \n \r \x1a " ' \\), so every statement is one line.
 */
import mysql from 'mysql2';

const NUM_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric', 'float', 'double', 'real', 'year']);
const BIN_TYPES = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'bit']);
const NUMERIC_RE = /^-?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;

export function columnKind(dataType) {
  const t = String(dataType || '').toLowerCase();
  if (NUM_TYPES.has(t)) return 'num';
  if (BIN_TYPES.has(t)) return 'bin';
  if (t === 'json') return 'json';
  return 'str';
}

export function quoteId(name) {
  return `\`${String(name).replace(/`/g, '``')}\``;
}

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}
function dateLiteral(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

export class SqlEncodeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.safe = true;
  }
}

/** One SQL literal. Never throws on data; throws only on a value that cannot be a MySQL value. */
export function encodeValue(v, kind = 'str') {
  if (v === null || v === undefined) return 'NULL';
  if (Buffer.isBuffer(v)) return `X'${v.toString('hex')}'`;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new SqlEncodeError('BAD_VALUE', 'Non-finite number in a row');
    return String(v);
  }
  if (v instanceof Date) return mysql.escape(dateLiteral(v));
  if (typeof v === 'string') {
    if (kind === 'num' && NUMERIC_RE.test(v)) return v;
    return mysql.escape(v);
  }
  // A parsed JSON value (should not happen with the JSON typeCast): keep it as JSON text.
  return mysql.escape(JSON.stringify(v));
}

export function rowTuple(row, cols, kinds) {
  let s = '(';
  for (let i = 0; i < cols.length; i += 1) {
    if (i) s += ',';
    s += encodeValue(row[cols[i]], kinds[i]);
  }
  return `${s})`;
}

/**
 * Packs row tuples into INSERT statements of at most `cap` bytes. A row bigger than `cap` becomes its own statement;
 * a statement bigger than `hardMax` (max_allowed_packet - 1 KiB) fails the backup: it could never be restored.
 */
export class InsertBatcher {
  constructor(table, cols, { cap, hardMax }) {
    this.table = table;
    this.prefix = `INSERT INTO ${quoteId(table)} (${cols.map(quoteId).join(',')}) VALUES `;
    this.prefixBytes = Buffer.byteLength(this.prefix, 'utf8');
    this.cap = cap;
    this.hardMax = hardMax;
    this.parts = [];
    this.bytes = this.prefixBytes;
  }

  /** Adds one tuple; returns a finished { sql, n } when the previous batch had to be flushed, else null. */
  add(tuple, keyHint = '') {
    const tb = Buffer.byteLength(tuple, 'utf8');
    if (this.prefixBytes + tb > this.hardMax) {
      throw new SqlEncodeError('ROW_TOO_LARGE', `A row in table ${this.table}${keyHint ? ` (key ${keyHint})` : ''} is larger than max_allowed_packet and could never be restored`);
    }
    let out = null;
    if (this.parts.length && this.bytes + 1 + tb > this.cap) out = this.flush();
    this.parts.push(tuple);
    this.bytes += (this.parts.length > 1 ? 1 : 0) + tb;
    return out;
  }

  flush() {
    if (!this.parts.length) return null;
    const res = { sql: this.prefix + this.parts.join(','), n: this.parts.length };
    this.parts = [];
    this.bytes = this.prefixBytes;
    return res;
  }
}

/** Statement cap: min(4 MiB, max_allowed_packet / 4); hard max = max_allowed_packet - 1 KiB. */
export function statementLimits(maxAllowedPacket) {
  const map = Number(maxAllowedPacket) > 0 ? Number(maxAllowedPacket) : 4 * 1024 * 1024;
  return { cap: Math.max(16 * 1024, Math.min(4 * 1024 * 1024, Math.floor(map / 4))), hardMax: Math.max(16 * 1024, map - 1024) };
}

const DEFINER_RE = /\s+DEFINER\s*=\s*(`(?:[^`]|``)*`|'(?:[^']|'')*'|[^\s@]+)@(`(?:[^`]|``)*`|'(?:[^']|'')*'|[^\s]+)/i;

/** Shared hosting cannot create objects for another definer: drop DEFINER=, force SQL SECURITY INVOKER on views. */
export function stripDefiner(ddl) {
  return String(ddl).replace(DEFINER_RE, '');
}
export function normalizeViewDdl(ddl) {
  let s = stripDefiner(ddl);
  if (/SQL\s+SECURITY\s+(DEFINER|INVOKER)/i.test(s)) s = s.replace(/SQL\s+SECURITY\s+(DEFINER|INVOKER)/i, 'SQL SECURITY INVOKER');
  else s = s.replace(/\s+VIEW\s+/i, ' SQL SECURITY INVOKER VIEW ');
  return s;
}
