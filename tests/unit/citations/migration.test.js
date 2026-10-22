/**
 * Migration 20261108_contract_180: additive and idempotent (guarded columns / indexes, CREATE TABLE IF NOT EXISTS,
 * INSERT IGNORE), and every new table / column is in schema.prisma.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(join(here, '../../../prisma/migrations/20261108_contract_180/migration.sql'), 'utf8');
const SCHEMA = readFileSync(join(here, '../../../prisma/schema.prisma'), 'utf8');
const code = SQL.replace(/^--.*$/gm, '');

describe('migration 20261108_contract_180', () => {
  it('is additive: no drop, rename, modify, truncate or delete', () => {
    expect(code).not.toMatch(/\bDROP\b|\bRENAME\b|\bMODIFY\b|\bTRUNCATE\b|(?<!ON )\bDELETE\b|CHANGE\s+COLUMN/i);
  });
  it('every column / index add is guarded; tables use IF NOT EXISTS; the config row uses INSERT IGNORE', () => {
    const adds = code.match(/ADD COLUMN `(\w+)`/g) || [];
    const guards = code.match(/COLUMN_NAME = '(\w+)'/g) || [];
    expect(adds.length).toBe(9);
    expect(guards.length).toBe(adds.length);
    expect((code.match(/CREATE UNIQUE INDEX/g) || []).length).toBe((code.match(/INDEX_NAME = '/g) || []).length);
    expect((code.match(/CREATE TABLE IF NOT EXISTS/g) || []).length).toBe(4);
    expect((code.match(/CREATE TABLE (?!IF NOT EXISTS)/g) || []).length).toBe(0);
    expect(code).toMatch(/INSERT IGNORE INTO `healthscoreconfig`/);
    expect(code).not.toMatch(/UPDATE `healthscoreconfig` SET[^;]*WHERE `version` = 1;/);
  });
  it('the tables and columns exist in schema.prisma', () => {
    for (const t of ['localranktask', 'seocitationmirror', 'seocitationstate', 'seocitationcheckrun']) expect(SCHEMA).toContain(`@@map("${t}")`);
    for (const c of ['promptId', 'mentionPosition', 'period', 'source']) expect(SCHEMA).toMatch(new RegExp(`\\n\\s+${c}\\s`));
  });
});

describe('migration 20261109_contract_180_fixes', () => {
  const FIX = readFileSync(join(here, '../../../prisma/migrations/20261109_contract_180_fixes/migration.sql'), 'utf8').replace(/^--.*$/gm, '');
  it('adds aivisibilityresult.promptSource, guarded and additive; the column is in schema.prisma', () => {
    expect(FIX).not.toMatch(/\bDROP\b|\bRENAME\b|\bMODIFY\b|\bTRUNCATE\b|\bDELETE\b|CHANGE\s+COLUMN/i);
    expect(FIX).toMatch(/COLUMN_NAME = 'promptSource'/);
    expect(FIX).toMatch(/ADD COLUMN `promptSource` VARCHAR\(16\) NULL/);
    expect(SCHEMA).toMatch(/\n\s+promptSource\s+String\?\s+@db\.VarChar\(16\)/);
  });
});
