/**
 * A small in-memory stand-in for the Prisma client, enough for the signals module (tests mock src/lib/prisma.js with
 * it). Supports: create, createMany (skipDuplicates + unique keys), findUnique (incl. compound keys), findFirst,
 * findMany (where / orderBy / take / skip / select / distinct), update, updateMany, upsert, delete, deleteMany, count,
 * $transaction (array or callback), $queryRaw (stub). Where: equality, null, Date, in / notIn / not / lt / lte / gt /
 * gte / startsWith, AND / OR / NOT. Update data: plain values and { increment }. Prisma.DbNull is stored as null.
 */
import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { assertPrismaArgs } from '../../helpers/prismaShape.js';

const UNIQUES = {
  signalEvent: [['projectId', 'eventId']],
  signalSession: [['projectId', 'sessionId']],
  leadAttribution: [['leadRowId'], ['projectId', 'siteLeadId']],
  signalIngestStat: [['projectId', 'date']],
  signalDailyBySource: [['projectId', 'date', 'refClass', 'refSource']],
  signalDailyByLanding: [['projectId', 'date', 'landingPath', 'refClass']],
  signalDailyByGeoDevice: [['projectId', 'date', 'country', 'region', 'formFactor']],
  signalRollupDirty: [['projectId', 'date']],
  signalConfigMirror: [['projectId']],
  cmsLead: [['projectId', 'leadId']],
  externalFormEndpoint: [['tokenHash'], ['projectId', 'provider']],
  externalFormReceipt: [['dedupeKey']],
};

const DEFAULTS = {
  leadAttribution: () => ({ needsDerive: true, mismatch: false, lastClass: 'unknown', lastSource: '', derivedAt: null, visitorId: null, sessionId: null, heardFrom: null, sitePath: null, firstTouch: null, lastTouch: null }),
  signalErasure: () => ({ siteState: 'none', siteAttempts: 0, at: new Date(), origin: 'os', siteNextAt: null, siteLastError: null, siteRows: null, siteConfirmedAt: null, pendingSubject: null, rowsEvents: 0, rowsSessions: 0, rowsAttributions: 0 }),
  signalIngestStat: () => ({ batches: 0, events: 0, innerDuplicates: 0, rejectedInvalid: 0, clamped: 0, botEvents: 0, siteSummary: null, siteSummaryAt: null }),
  signalEvent: () => ({ sessionizedAt: null, payloadCompactedAt: null, visitorId: null, refSource: null, country: null, leadId: null, botScore: 0 }),
  signalSession: () => ({ rescoreBotScore: null, leadCount: 0, formSubmits: 0 }),
  signalConfigMirror: () => ({ stale: false, rev: null, config: null, buffer: null }),
  cmsLead: () => ({ erasedAt: null, erasedReason: null, siteCreatedAt: null, receivedAt: new Date(), provider: 'emdash', externalId: null, externalUrl: null, cmsMirrorLeadId: null, mirrorState: null, mirrorAttempts: 0, mirrorNextAt: null, mirrorError: null, externalErasePending: false }),
  externalFormEndpoint: () => ({ provider: 'ghl', headerSecretHash: null, rotatedAt: null, prevTokenHash: null, prevValidUntil: null, revokedAt: null, lastReceivedAt: null, createdAt: new Date() }),
  externalFormReceipt: () => ({ provider: 'ghl', receivedAt: new Date(), reason: null, shape: null, payloadHash: null, dedupeKey: null, externalId: null, formId: null, leadId: null, duplicateOf: null, ipHash: null, bytes: 0 }),
};

const OPS = new Set(['in', 'notIn', 'not', 'lt', 'lte', 'gt', 'gte', 'equals', 'startsWith', 'contains']);
const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && typeof v !== 'bigint';
const norm = (v) => (v instanceof Date ? v.getTime() : typeof v === 'bigint' ? Number(v) : v);
const clone = (v) => (v instanceof Date ? new Date(v) : Array.isArray(v) ? v.map(clone) : isPlain(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) : v);
const dbVal = (v) => (v === Prisma.DbNull || v === Prisma.JsonNull ? null : clone(v));

function cmp(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (x === y) return 0;
  if (x === null || x === undefined) return -1;
  if (y === null || y === undefined) return 1;
  return x < y ? -1 : 1;
}

function matchField(value, cond) {
  if (isPlain(cond) && Object.keys(cond).some((k) => OPS.has(k))) {
    for (const [op, arg] of Object.entries(cond)) {
      if (op === 'equals' && cmp(value, arg) !== 0) return false;
      if (op === 'in' && !arg.some((a) => cmp(value, a) === 0)) return false;
      if (op === 'notIn' && arg.some((a) => cmp(value, a) === 0)) return false;
      if (op === 'not') {
        if (isPlain(arg) ? matchField(value, arg) : arg === null ? value === null || value === undefined : cmp(value, arg) === 0) return false;
      }
      if (op === 'lt' && !(value !== null && value !== undefined && cmp(value, arg) < 0)) return false;
      if (op === 'lte' && !(value !== null && value !== undefined && cmp(value, arg) <= 0)) return false;
      if (op === 'gt' && !(value !== null && value !== undefined && cmp(value, arg) > 0)) return false;
      if (op === 'gte' && !(value !== null && value !== undefined && cmp(value, arg) >= 0)) return false;
      if (op === 'startsWith' && !(typeof value === 'string' && value.startsWith(arg))) return false;
      if (op === 'contains' && !(typeof value === 'string' && value.includes(arg))) return false;
    }
    return true;
  }
  if (cond === null) return value === null || value === undefined;
  return cmp(value, cond) === 0;
}

function matches(row, where) {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (k === 'AND') {
      if (!(Array.isArray(cond) ? cond : [cond]).every((w) => matches(row, w))) return false;
    } else if (k === 'OR') {
      if (!cond.some((w) => matches(row, w))) return false;
    } else if (k === 'NOT') {
      if ((Array.isArray(cond) ? cond : [cond]).some((w) => matches(row, w))) return false;
    } else if (isPlain(cond) && !Object.keys(cond).some((x) => OPS.has(x)) && !(k in row)) {
      // compound unique key, e.g. projectId_sessionId: { projectId, sessionId }
      if (!matches(row, cond)) return false;
    } else if (!matchField(row[k], cond)) return false;
  }
  return true;
}

const RELATIONS = { cmsLead: { photos: ['cmsLeadPhoto', 'leadRowId', true], attribution: ['leadAttribution', 'leadRowId', false] } };

function pick(row, select) {
  if (!select) return clone(row);
  const out = {};
  for (const [k, v] of Object.entries(select)) if (v) out[k] = clone(row[k]);
  return out;
}

/** Relations named in a select (`attribution: { select }`) are loaded like an include. */
const relSelect = (select, include) => {
  const fromSelect = select ? Object.fromEntries(Object.entries(select).filter(([, v]) => isPlain(v))) : {};
  return Object.keys(fromSelect).length || include ? { ...(include || {}), ...fromSelect } : undefined;
};

function sortRows(rows, orderBy) {
  if (!orderBy) return rows;
  const list = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const o of list) {
      const [k, dir] = Object.entries(o)[0];
      const c = cmp(a[k], b[k]);
      if (c) return dir === 'desc' ? -c : c;
    }
    return 0;
  });
}

export function createFakePrisma({ queryRaw = async () => [] } = {}) {
  const tables = new Map();
  let seq = 0n;
  const rowsOf = (name) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  };
  const keyOf = (name, row, cols) => cols.map((c) => String(norm(row[c]))).join('\u0000');
  const conflicts = (name, row, except = null) =>
    (UNIQUES[name] || []).some((cols) => cols.every((c) => row[c] !== undefined && row[c] !== null) && rowsOf(name).some((r) => r !== except && keyOf(name, r, cols) === keyOf(name, row, cols)));

  function applyData(row, data) {
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (isPlain(v) && 'increment' in v) row[k] = (Number(row[k]) || 0) + v.increment;
      else if (isPlain(v) && 'decrement' in v) row[k] = (Number(row[k]) || 0) - v.decrement;
      else row[k] = dbVal(v);
    }
    if ('updatedAt' in row || true) row.updatedAt = new Date();
    return row;
  }

  function insert(name, data) {
    const row = { ...(DEFAULTS[name]?.() || {}), createdAt: new Date(), updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = dbVal(v);
    if (row.id === undefined) {
      if (name === 'signalEvent') {
        seq += 1n;
        row.id = seq;
      } else row.id = crypto.randomUUID();
    }
    if (conflicts(name, row)) {
      const e = new Error(`Unique constraint failed on ${name}`);
      e.code = 'P2002';
      throw e;
    }
    rowsOf(name).push(row);
    return row;
  }

  const model = (name) => ({
    async create({ data, select }) {
      return pick(insert(name, data), select);
    },
    async createMany({ data, skipDuplicates = false }) {
      let count = 0;
      for (const d of data) {
        try {
          insert(name, d);
          count += 1;
        } catch (e) {
          if (!(skipDuplicates && e.code === 'P2002')) throw e;
        }
      }
      return { count };
    },
    async findUnique({ where, select, include }) {
      const r = rowsOf(name).find((x) => matches(x, where));
      return r ? withInclude(r, pick(r, select), relSelect(select, include)) : null;
    },
    async findFirst({ where, orderBy, select } = {}) {
      const r = sortRows(rowsOf(name).filter((x) => matches(x, where)), orderBy)[0];
      return r ? pick(r, select) : null;
    },
    async findMany({ where, orderBy, take, skip = 0, select, distinct } = {}) {
      let rows = sortRows(rowsOf(name).filter((x) => matches(x, where)), orderBy);
      if (distinct) {
        const seen = new Set();
        rows = rows.filter((r) => {
          const k = distinct.map((c) => String(norm(r[c]))).join('\u0000');
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }
      rows = rows.slice(skip, take === undefined ? undefined : skip + take);
      return rows.map((r) => withInclude(r, pick(r, select), relSelect(select, arguments[0]?.include)));
    },
    async count({ where } = {}) {
      return rowsOf(name).filter((x) => matches(x, where)).length;
    },
    async update({ where, data, select }) {
      const r = rowsOf(name).find((x) => matches(x, where));
      if (!r) {
        const e = new Error(`${name} not found`);
        e.code = 'P2025';
        throw e;
      }
      return pick(applyData(r, data), select);
    },
    async updateMany({ where, data }) {
      const rows = rowsOf(name).filter((x) => matches(x, where));
      for (const r of rows) applyData(r, data);
      return { count: rows.length };
    },
    async upsert({ where, create, update, select }) {
      const r = rowsOf(name).find((x) => matches(x, where));
      if (r) return pick(applyData(r, update), select);
      return pick(insert(name, create), select);
    },
    async delete({ where }) {
      const list = rowsOf(name);
      const i = list.findIndex((x) => matches(x, where));
      if (i < 0) throw Object.assign(new Error('not found'), { code: 'P2025' });
      return list.splice(i, 1)[0];
    },
    async deleteMany({ where } = {}) {
      const list = rowsOf(name);
      const keep = list.filter((x) => !matches(x, where));
      const n = list.length - keep.length;
      tables.set(name, keep);
      return { count: n };
    },
  });

  function withInclude(row, out, include) {
    if (!include) return out;
    for (const [k, on] of Object.entries(include)) {
      const rel = on && RELATIONS[nameOf(row)]?.[k];
      if (!rel) continue;
      const list = rowsOf(rel[0]).filter((x) => x[rel[1]] === row.id).map(clone);
      out[k] = rel[2] ? list : list[0] || null;
    }
    return out;
  }
  const nameOf = (row) => [...tables.entries()].find(([, list]) => list.includes(row))?.[0];
  const txCalls = [];
  const models = new Map();
  const client = new Proxy(
    {},
    {
      get(_, prop) {
        if (prop === '$transaction') return async (arg) => (txCalls.push(arg), typeof arg === 'function' ? arg(client) : Promise.all(arg));
        if (prop === '_txCalls') return txCalls;
        if (prop === '$queryRaw') return (...args) => queryRaw(...args);
        if (prop === '_tables') return tables;
        if (prop === '_rows') return (name) => rowsOf(name);
        if (prop === '_reset') return () => (tables.clear(), (txCalls.length = 0));
        if (prop === 'then') return undefined;
        if (!models.has(prop)) {
          // Every call is checked against the real schema (tests/helpers/prismaShape.js) before the in-memory op runs.
          const m = model(String(prop));
          models.set(prop, Object.fromEntries(Object.entries(m).map(([k, fn]) => [k, typeof fn === 'function' ? (args, ...rest) => (assertPrismaArgs(String(prop), k, args), fn(args, ...rest)) : fn])));
        }
        return models.get(prop);
      },
    }
  );
  return client;
}
