/**
 * Migration 20261114_bing_webmaster: additive and idempotent (information_schema + PREPARE per column, CREATE TABLE IF
 * NOT EXISTS, the config proposal inserted once and never activated), and tests/setup/db.js truncates the new tables.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(join(here, '../../../prisma/migrations/20261114_bing_webmaster/migration.sql'), 'utf8');
const code = SQL.replace(/^--.*$/gm, '');
const TABLES = ['agencybingconnection', 'bingdailymetric', 'bingcrawldaily', 'bingqueryweekly', 'bingpageweekly', 'bingcrawlissue', 'bingsitestate', 'bingserprankdaily'];

describe('migration 20261114_bing_webmaster', () => {
  it('is additive: no drop, rename, modify, truncate, delete or update', () => {
    expect(code).not.toMatch(/\bDROP\b|\bRENAME\b|\bMODIFY\b|\bTRUNCATE\b|(?<!ON )\bDELETE\b|CHANGE\s+COLUMN|(?<!ON )\bUPDATE\b(?! CASCADE)/i);
  });

  it('every column add is guarded by information_schema + PREPARE and every table by IF NOT EXISTS', () => {
    const adds = code.match(/ADD COLUMN `(\w+)`/g) || [];
    const guards = code.match(/COLUMN_NAME = '(\w+)'/g) || [];
    expect(adds).toHaveLength(6);
    expect(guards).toHaveLength(adds.length);
    expect((code.match(/PREPARE stmt FROM @sql/g) || []).length).toBe(6);
    for (const t of TABLES) expect(code).toContain(`CREATE TABLE IF NOT EXISTS \`${t}\``);
    expect((code.match(/CREATE TABLE (?!IF NOT EXISTS)/g) || []).length).toBe(0);
    expect(code).toMatch(/DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci/);
  });

  it('the health config proposal is inserted only when absent and stays inactive', () => {
    expect(code).toMatch(/WHERE @have = 0;/);
    expect(code).toMatch(/', 0, 'v3 proposal/);
  });

  it('tests/setup/db.js truncates the new tables', () => {
    const setup = readFileSync(join(here, '../../setup/db.js'), 'utf8');
    for (const t of TABLES) expect(setup).toContain(`'${t}'`);
  });
});
