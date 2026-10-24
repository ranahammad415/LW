/**
 * Schema compatibility (plan f.4). B = the backup's applied migrations (manifest), C = the migration folders shipped
 * with this code. B == C → SAME; B ⊂ C → OLDER (allowed with an acknowledgement, ends in NEEDS_MIGRATION);
 * B ⊄ C → NEWER (made by newer code: refused, deploy the newer code first).
 */
import fs from 'fs';
import path from 'path';
import { MIGRATIONS_DIR } from './config.js';

export function listCodeMigrations(dir = MIGRATIONS_DIR) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'migration.sql')))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export function compareSchema(backupNames = [], codeNames = []) {
  const B = new Set(backupNames);
  const C = new Set(codeNames);
  const unknown = [...B].filter((n) => !C.has(n)).sort();
  const missing = [...C].filter((n) => !B.has(n)).sort();
  if (unknown.length) return { status: 'NEWER', missingMigrations: missing, unknownMigrations: unknown };
  if (missing.length) return { status: 'OLDER', missingMigrations: missing, unknownMigrations: [] };
  return { status: 'SAME', missingMigrations: [], unknownMigrations: [] };
}

/** maintenance/clear: the DB must now hold every migration of the code (D ⊇ C). */
export function dbHasAllMigrations(dbNames = [], codeNames = []) {
  const D = new Set(dbNames);
  const missing = codeNames.filter((n) => !D.has(n));
  return { ok: missing.length === 0, missing };
}
