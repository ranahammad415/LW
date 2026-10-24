/**
 * Test helper: a small stateful in-memory stand-in for the Prisma delegates the MCP server uses (mcp* models,
 * agencySetting, user, task, clientUser, clientAccount). Every call is first checked against the generated client's
 * schema with assertPrismaArgs, so a wrong field name fails here like it would against MySQL.
 * Supports the where operators the MCP code uses: equality, null, { in }, { lt, lte, gt, gte, not }, OR / AND, and
 * relation `none: {}` on McpClient.grants. include: grant / client / user / grants (count only via none).
 */
import { randomUUID } from 'crypto';
import { assertPrismaArgs } from './prismaShape.js';

const RELATIONS = {
  mcpToken: { grant: ['mcpGrant', 'grantId'] },
  mcpGrant: { client: ['mcpClient', 'clientId'], user: ['user', 'userId'] },
  mcpAuthRequest: { client: ['mcpClient', 'clientId'] },
};

const DEFAULTS = {
  mcpClient: () => ({ tokenEndpointAuthMethod: 'none', clientSecretHash: null, scope: null, clientUri: null, logoUri: null, softwareId: null, softwareVersion: null, registrationIp: null, lastUsedAt: null, disabledAt: null, disabledById: null, createdAt: new Date() }),
  mcpAuthRequest: () => ({ status: 'pending', codeChallengeMethod: 'S256', userId: null, codeHash: null, codeExpiresAt: null, grantId: null, state: null, ip: null, createdAt: new Date() }),
  mcpGrant: () => ({ userTokenVersion: 0, lastUsedAt: null, revokedAt: null, revokedById: null, revokedReason: null, createdAt: new Date() }),
  mcpToken: () => ({ parentId: null, usedAt: null, revokedAt: null, createdAt: new Date() }),
  mcpConfirmation: () => ({ consumedAt: null, routeKey: null, createdAt: new Date() }),
  mcpAuditLog: () => ({ createdAt: new Date() }),
  agencySetting: () => ({ mcpPausedAt: null, mcpPausedById: null }),
};

function cmp(a, b) {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  return x < y ? -1 : x > y ? 1 : 0;
}

function matchValue(v, cond) {
  if (cond === null) return v === null || v === undefined;
  if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
  if (typeof cond === 'object' && !Array.isArray(cond)) {
    for (const [op, arg] of Object.entries(cond)) {
      if (op === 'in' && !arg.includes(v)) return false;
      if (op === 'notIn' && arg.includes(v)) return false;
      if (op === 'not' && (arg === null ? v === null || v === undefined : v === arg)) return false;
      if (op === 'lt' && !(v != null && cmp(v, arg) < 0)) return false;
      if (op === 'lte' && !(v != null && cmp(v, arg) <= 0)) return false;
      if (op === 'gt' && !(v != null && cmp(v, arg) > 0)) return false;
      if (op === 'gte' && !(v != null && cmp(v, arg) >= 0)) return false;
    }
    return true;
  }
  return v === cond;
}

export function createFakeMcpDb() {
  const tables = {
    mcpClient: [], mcpAuthRequest: [], mcpGrant: [], mcpToken: [], mcpConfirmation: [], mcpAuditLog: [],
    agencySetting: [], user: [], task: [], clientUser: [], clientAccount: [], project: [],
  };
  const calls = [];

  function matches(model, row, where = {}) {
    for (const [k, cond] of Object.entries(where || {})) {
      if (cond === undefined) continue;
      if (k === 'OR') {
        if (!cond.some((w) => matches(model, row, w))) return false;
        continue;
      }
      if (k === 'AND') {
        if (!cond.every((w) => matches(model, row, w))) return false;
        continue;
      }
      if (model === 'mcpClient' && k === 'grants') {
        const n = tables.mcpGrant.filter((g) => g.clientId === row.id).length;
        if (cond.none && n > 0) return false;
        continue;
      }
      if (!matchValue(row[k], cond)) return false;
    }
    return true;
  }

  function withInclude(model, row, include) {
    if (!row || !include) return row ? { ...row } : row;
    const out = { ...row };
    for (const [rel, spec] of Object.entries(include)) {
      const r = RELATIONS[model]?.[rel];
      if (!r) continue;
      const [target, fk] = r;
      const found = tables[target].find((x) => x.id === row[fk]) || null;
      const nested = spec && typeof spec === 'object' && spec.include ? spec.include : null;
      let val = withInclude(target, found, nested);
      if (val && spec && typeof spec === 'object' && spec.select) val = Object.fromEntries(Object.keys(spec.select).map((f) => [f, val[f]]));
      out[rel] = val;
    }
    return out;
  }

  function project(row, select) {
    if (!row || !select) return row;
    return Object.fromEntries(Object.keys(select).map((f) => [f, row[f]]));
  }

  const delegate = (model) => ({
    async findUnique(args) {
      const row = tables[model].find((r) => matches(model, r, args.where)) || null;
      return project(withInclude(model, row, args.include), args.select);
    },
    async findFirst(args = {}) {
      const row = tables[model].find((r) => matches(model, r, args.where)) || null;
      return project(withInclude(model, row, args.include), args.select);
    },
    async findMany(args = {}) {
      let rows = tables[model].filter((r) => matches(model, r, args.where));
      if (args.orderBy?.createdAt) rows = [...rows].sort((a, b) => cmp(b.createdAt, a.createdAt) * (args.orderBy.createdAt === 'desc' ? 1 : -1));
      if (args.skip) rows = rows.slice(args.skip);
      if (args.take) rows = rows.slice(0, args.take);
      return rows.map((r) => project(withInclude(model, r, args.include), args.select));
    },
    async count(args = {}) {
      return tables[model].filter((r) => matches(model, r, args.where)).length;
    },
    async create(args) {
      const row = { ...(DEFAULTS[model]?.() || {}), id: args.data.id || randomUUID(), ...args.data };
      for (const k of ['codeHash', 'tokenHash']) {
        if (row[k] && tables[model].some((r) => r[k] === row[k])) {
          const e = new Error('Unique constraint');
          e.code = 'P2002';
          throw e;
        }
      }
      tables[model].push(row);
      return project({ ...row }, args.select);
    },
    async createMany(args) {
      for (const d of args.data) tables[model].push({ ...(DEFAULTS[model]?.() || {}), id: randomUUID(), ...d });
      return { count: args.data.length };
    },
    async update(args) {
      const row = tables[model].find((r) => matches(model, r, args.where));
      if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      Object.assign(row, args.data);
      return project({ ...row }, args.select);
    },
    async updateMany(args) {
      const rows = tables[model].filter((r) => matches(model, r, args.where));
      for (const r of rows) Object.assign(r, args.data);
      return { count: rows.length };
    },
    async deleteMany(args = {}) {
      const keep = tables[model].filter((r) => !matches(model, r, args.where));
      const n = tables[model].length - keep.length;
      tables[model] = keep;
      return { count: n };
    },
  });

  const db = {};
  for (const model of Object.keys(tables)) {
    const d = delegate(model);
    db[model] = new Proxy(d, {
      get(target, method) {
        const fn = target[method];
        if (typeof fn !== 'function') return fn;
        return async (args) => {
          calls.push({ key: `${model}.${String(method)}`, args });
          assertPrismaArgs(model, method, args);
          return fn(args);
        };
      },
    });
  }
  db.$transaction = async (arg) => (typeof arg === 'function' ? arg(db) : Promise.all(arg));
  db._tables = tables;
  db._calls = calls;
  return db;
}
