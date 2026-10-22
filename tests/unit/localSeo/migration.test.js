/**
 * Migration 20261107_local_seo_dfs: additive and idempotent, and the place_id move out of gmbCid is data-safe
 * (copy first, clear only where the copy matches). The code keeps reading rows the migration has not touched
 * (identity.test.js "migration compatibility").
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(join(here, '../../../prisma/migrations/20261107_local_seo_dfs/migration.sql'), 'utf8');
const code = SQL.replace(/^--.*$/gm, '');

describe('migration 20261107_local_seo_dfs', () => {
  it('is additive: no drop, rename, modify or truncate', () => {
    // "ON DELETE CASCADE" in the inline foreign keys is fine; a DELETE statement is not.
    expect(code).not.toMatch(/\bDROP\b|\bRENAME\b|\bMODIFY\b|\bTRUNCATE\b|(?<!ON )\bDELETE\b|CHANGE\s+COLUMN/i);
  });

  it('every column add is guarded by information_schema and every table by IF NOT EXISTS', () => {
    const adds = code.match(/ADD COLUMN `(\w+)`/g) || [];
    const guards = code.match(/COLUMN_NAME = '(\w+)'/g) || [];
    expect(adds.length).toBe(32);
    expect(guards.length).toBe(adds.length);
    expect((code.match(/CREATE TABLE IF NOT EXISTS/g) || []).length).toBe(3);
    expect((code.match(/CREATE TABLE (?!IF NOT EXISTS)/g) || []).length).toBe(0);
  });

  it('moves place_id: values safely (copy, then clear only matching rows; literal underscore escaped)', () => {
    const copy = code.indexOf("SET `gmbPlaceId` = TRIM(SUBSTRING(`gmbCid`, 10))");
    const clear = code.indexOf('SET `gmbCid` = NULL');
    expect(copy).toBeGreaterThan(0);
    expect(clear).toBeGreaterThan(copy);
    expect(code).toMatch(/`gmbPlaceId` IS NULL AND CHAR_LENGTH/);
    expect(code).toMatch(/WHERE `gmbCid` LIKE 'place\\_id:%' AND `gmbPlaceId` = TRIM\(SUBSTRING\(`gmbCid`, 10\)\)/);
    expect(code).toMatch(/REGEXP '\^\[0-9\]\+\$'/);
  });
});
