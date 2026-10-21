/**
 * Prisma needs Prisma.DbNull (not null) to clear a nullable Json column. J(data) rewrites null on the security
 * models' Json fields; every other value (and null on scalar columns) passes unchanged.
 */
import { Prisma } from '@prisma/client';

export const SECURITY_JSON_FIELDS = new Set([
  'evidence',
  'acknowledged',
  'refs',
  'counts',
  'categories',
  'lastBuild',
  'disabled',
  'lastScan',
  'backups',
  'lastRestoreTest',
  'checks',
  'restoreTest',
  'by',
  'config',
]);

export function J(data) {
  if (!data || typeof data !== 'object') return data;
  const out = { ...data };
  for (const k of Object.keys(out)) if (out[k] === null && SECURITY_JSON_FIELDS.has(k)) out[k] = Prisma.DbNull;
  return out;
}
