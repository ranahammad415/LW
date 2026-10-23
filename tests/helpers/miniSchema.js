/**
 * Test helper: a small JSON Schema (2020-12 subset) checker for the contract fixtures (no new dependency). Supports
 * type, properties, required, additionalProperties (false / schema), enum, const, pattern, minLength / maxLength,
 * maxProperties, items, anyOf / oneOf, allOf, if / then / else, not, format date-time, and $ref to "common.json#/$defs/x" or "#/$defs/x".
 * Returns a list of problems ([] = valid). Enough for request bodies the OS builds; not a general validator.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS = path.join(here, '../fixtures/cms-contract/schemas');
const cache = new Map();
export const loadSchema = (name) => {
  if (!cache.has(name)) cache.set(name, JSON.parse(readFileSync(path.join(SCHEMAS, name), 'utf8')));
  return cache.get(name);
};

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function resolve(ref, file) {
  const [f, frag] = ref.split('#');
  const doc = loadSchema(f || file);
  let node = doc;
  for (const part of (frag || '').split('/').filter(Boolean)) node = node[part];
  return { schema: node, file: f || file };
}

export function schemaErrors(value, schema, file = 'common.json', at = '$') {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [`${at}: not allowed`];
  if (schema.$ref) {
    const r = resolve(schema.$ref, file);
    return schemaErrors(value, r.schema, r.file, at);
  }
  const errs = [];
  // allOf, if / then / else and not (the events.request per-type data rules, contract 1.6.0+).
  if (Array.isArray(schema.allOf)) for (const s of schema.allOf) errs.push(...schemaErrors(value, s, file, at));
  if (schema.if !== undefined) {
    const branch = schemaErrors(value, schema.if, file, at).length === 0 ? schema.then : schema.else;
    if (branch !== undefined) errs.push(...schemaErrors(value, branch, file, at));
  }
  if (schema.not !== undefined && schemaErrors(value, schema.not, file, at).length === 0) errs.push(`${at}: matches a "not" schema`);
  if (schema.anyOf || schema.oneOf) {
    const list = schema.anyOf || schema.oneOf;
    if (!list.some((s) => schemaErrors(value, s, file, at).length === 0)) errs.push(`${at}: matches no anyOf branch`);
  }
  if (schema.const !== undefined && value !== schema.const) errs.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    if (!types.includes(t) && !(t === 'integer' && types.includes('number'))) return [...errs, `${at}: expected ${types.join('|')}, got ${t}`];
  }
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${at}: does not match ${schema.pattern}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.format === 'date-time' && !DATE_TIME.test(value)) errs.push(`${at}: not a date-time`);
  }
  if (typeOf(value) === 'object') {
    const props = schema.properties || {};
    for (const k of schema.required || []) if (!(k in value)) errs.push(`${at}.${k}: required`);
    if (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties) errs.push(`${at}: more than ${schema.maxProperties} properties`);
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) errs.push(...schemaErrors(v, props[k], file, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}.${k}: additional property`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errs.push(...schemaErrors(v, schema.additionalProperties, file, `${at}.${k}`));
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errs.push(...schemaErrors(v, schema.items, file, `${at}[${i}]`)));
  return errs;
}

/** Problems of `value` against fixtures schema `name` (e.g. "lead-import.request.json"). */
export const validateAgainst = (name, value) => schemaErrors(value, loadSchema(name), name);
