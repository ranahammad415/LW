/**
 * Test helper: validates the arguments of a Prisma delegate call (select / include / omit / where / orderBy / data /
 * distinct / groupBy `by` / aggregates) against the generated client's DMMF (`Prisma.dmmf.datamodel`).
 *
 * Unit tests mock src/lib/prisma.js, so a select of a field that does not exist (e.g. `client: { select: { name: true } }`
 * on Project, where ClientAccount has `agencyName`) passes every mock and only fails against a real database
 * (release-3 e2e O-R3-1). Mock proxies call `assertPrismaArgs(delegate, method, args)` so every recorded call is
 * checked against the real schema. Needs `npx prisma generate` to have run for the current schema.
 */
import { Prisma } from '@prisma/client';

const MODELS = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));
const LOWER = new Map([...MODELS.keys()].map((n) => [n.charAt(0).toLowerCase() + n.slice(1), n]));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

const ARG_METHODS = new Set([
  'findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy',
  'create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany',
]);

function fieldsOf(model) {
  return new Map(model.fields.map((f) => [f.name, f]));
}

function compoundNames(model) {
  const out = new Set();
  for (const u of model.uniqueIndexes || []) {
    if (u.fields.length > 1) out.add(u.name || u.fields.join('_'));
  }
  for (const u of model.uniqueFields || []) if (u.length > 1) out.add(u.join('_'));
  if (model.primaryKey?.fields?.length > 1) out.add(model.primaryKey.name || model.primaryKey.fields.join('_'));
  return out;
}

function checkWhere(model, where, path, errors) {
  if (!isObj(where)) return;
  const fields = fieldsOf(model);
  const compounds = compoundNames(model);
  for (const [key, val] of Object.entries(where)) {
    if (val === undefined) continue;
    if (key === 'AND' || key === 'OR' || key === 'NOT') {
      for (const w of Array.isArray(val) ? val : [val]) checkWhere(model, w, `${path}.${key}`, errors);
      continue;
    }
    if (compounds.has(key)) {
      continue;
    }
    const f = fields.get(key);
    if (!f) {
      errors.push(`${path}: unknown field '${key}' on model '${model.name}'`);
      continue;
    }
    if (f.kind !== 'object' || !isObj(val)) continue;
    const rel = MODELS.get(f.type);
    if (f.isList) {
      for (const op of ['some', 'every', 'none']) if (isObj(val[op])) checkWhere(rel, val[op], `${path}.${key}.${op}`, errors);
    } else if (Object.keys(val).every((k) => k === 'is' || k === 'isNot')) {
      for (const op of ['is', 'isNot']) if (isObj(val[op])) checkWhere(rel, val[op], `${path}.${key}.${op}`, errors);
    } else {
      checkWhere(rel, val, `${path}.${key}`, errors);
    }
  }
}

function checkOrderBy(model, orderBy, path, errors) {
  for (const o of Array.isArray(orderBy) ? orderBy : [orderBy]) {
    if (!isObj(o)) continue;
    const fields = fieldsOf(model);
    for (const [key, val] of Object.entries(o)) {
      if (key === '_relevance' || ['_count', '_sum', '_avg', '_min', '_max'].includes(key)) continue;
      const f = fields.get(key);
      if (!f) {
        errors.push(`${path}: unknown orderBy field '${key}' on model '${model.name}'`);
      } else if (f.kind === 'object' && isObj(val) && !('_count' in val)) {
        checkOrderBy(MODELS.get(f.type), val, `${path}.${key}`, errors);
      }
    }
  }
}

function checkCountSelect(model, sel, path, errors) {
  if (!isObj(sel)) return;
  const fields = fieldsOf(model);
  for (const [key, val] of Object.entries(sel)) {
    const f = fields.get(key);
    if (!f || f.kind !== 'object') {
      errors.push(`${path}: '_count' of unknown relation '${key}' on model '${model.name}'`);
    } else if (isObj(val) && val.where) {
      checkWhere(MODELS.get(f.type), val.where, `${path}.${key}.where`, errors);
    }
  }
}

function checkSelection(model, sel, kind, path, errors) {
  if (!isObj(sel)) return;
  const fields = fieldsOf(model);
  for (const [key, val] of Object.entries(sel)) {
    if (val === undefined || val === false) continue;
    if (key === '_count') {
      if (isObj(val)) checkCountSelect(model, val.select, `${path}._count.select`, errors);
      continue;
    }
    const f = fields.get(key);
    if (!f) {
      errors.push(`${path}: unknown field '${key}' on model '${model.name}' (${kind})`);
      continue;
    }
    if (kind === 'include' && f.kind !== 'object') errors.push(`${path}: include of scalar field '${key}' on model '${model.name}'`);
    if (f.kind === 'object' && isObj(val)) checkArgs(MODELS.get(f.type), val, `${path}.${key}`, errors);
    else if (f.kind !== 'object' && val !== true) errors.push(`${path}: scalar '${key}' must be selected with true`);
  }
}

function checkData(model, data, path, errors) {
  for (const row of Array.isArray(data) ? data : [data]) {
    if (!isObj(row)) continue;
    const fields = fieldsOf(model);
    for (const key of Object.keys(row)) {
      if (!fields.has(key)) errors.push(`${path}: unknown data field '${key}' on model '${model.name}'`);
    }
  }
}

function checkFieldList(model, list, path, errors) {
  const fields = fieldsOf(model);
  for (const key of Array.isArray(list) ? list : [list]) {
    if (typeof key === 'string' && !fields.has(key)) errors.push(`${path}: unknown field '${key}' on model '${model.name}'`);
  }
}

function checkArgs(model, args, path, errors) {
  if (!isObj(args)) return;
  if (args.select && args.include) errors.push(`${path}: select and include together`);
  checkSelection(model, args.select, 'select', `${path}.select`, errors);
  checkSelection(model, args.include, 'include', `${path}.include`, errors);
  if (isObj(args.omit)) checkFieldList(model, Object.keys(args.omit), `${path}.omit`, errors);
  checkWhere(model, args.where, `${path}.where`, errors);
  if (args.cursor) checkWhere(model, args.cursor, `${path}.cursor`, errors);
  if (args.orderBy) checkOrderBy(model, args.orderBy, `${path}.orderBy`, errors);
  if (args.distinct) checkFieldList(model, args.distinct, `${path}.distinct`, errors);
}

/** Problems with one delegate call's arguments ([] when it matches the schema). */
export function prismaShapeErrors(delegate, method, args) {
  const name = LOWER.get(String(delegate));
  if (!name) return String(delegate).startsWith('$') ? [] : [`unknown Prisma delegate '${delegate}'`];
  if (!ARG_METHODS.has(String(method)) || !isObj(args)) return [];
  const model = MODELS.get(name);
  const errors = [];
  const p = `${delegate}.${method}`;
  if (method === 'count') {
    if (isObj(args.select)) checkFieldList(model, Object.keys(args.select).filter((k) => k !== '_all'), `${p}.select`, errors);
    checkWhere(model, args.where, `${p}.where`, errors);
    return errors;
  }
  checkArgs(model, args, p, errors);
  if (method === 'upsert') {
    checkData(model, args.create, `${p}.create`, errors);
    checkData(model, args.update, `${p}.update`, errors);
  } else if (args.data !== undefined) {
    checkData(model, args.data, `${p}.data`, errors);
  }
  if (method === 'groupBy' && args.by) checkFieldList(model, args.by, `${p}.by`, errors);
  for (const agg of ['_sum', '_avg', '_min', '_max', '_count']) {
    if (isObj(args[agg])) checkFieldList(model, Object.keys(args[agg]).filter((k) => k !== '_all'), `${p}.${agg}`, errors);
  }
  return errors;
}

const VIOLATIONS = [];

/**
 * Throws when a delegate call selects / filters / writes a field the Prisma schema does not have. The problem is also
 * remembered, because code under test may catch the throw (a route answering 500): tests read it with
 * takeShapeViolations() in an afterEach.
 */
export function assertPrismaArgs(delegate, method, args) {
  const errors = prismaShapeErrors(delegate, method, args);
  if (errors.length) {
    VIOLATIONS.push(...errors);
    throw new Error(`Prisma shape check failed: ${errors.join('; ')}`);
  }
}

/** Returns and clears the problems recorded since the last call. */
export function takeShapeViolations() {
  return VIOLATIONS.splice(0);
}

/**
 * Wraps a hand-written mock (`{ model: { method: fn } }`) so each call is checked with assertPrismaArgs first.
 * `$`-prefixed members ($transaction, $queryRaw) pass through unchanged.
 */
export function shapeChecked(mock) {
  const wrapped = {};
  for (const [name, delegate] of Object.entries(mock)) {
    if (name.startsWith('$') || !delegate || typeof delegate !== 'object') {
      wrapped[name] = delegate;
      continue;
    }
    wrapped[name] = Object.fromEntries(
      Object.entries(delegate).map(([method, fn]) => [
        method,
        typeof fn === 'function' ? (args, ...rest) => (assertPrismaArgs(name, method, args), fn(args, ...rest)) : fn,
      ])
    );
  }
  return wrapped;
}
