/**
 * Seed HealthScoreConfig version 1 (health score v2, docs/ledger/features/health-score.md) when it is absent.
 * The migration 20261105_health_score_v2 inserts the same row; this script is for DBs synced with `db push`.
 * Idempotent: never overwrites an existing version 1 and never changes which version is active
 * (version 1 is made active only when no active version exists).
 *
 *   node prisma/seed-health-config.cjs
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const V2_NOTE = 'v2 defaults (R5 listings consistency, A1 AI citation rate)';

async function main() {
  const { DEFAULT_CONFIG_V1, DEFAULT_CONFIG_V2 } = await import('../src/lib/health/defaultConfig.js');
  const existing = await prisma.healthScoreConfig.findUnique({ where: { version: 1 } });
  if (existing) {
    console.log('[seed-health-config] version 1 already present.');
  } else {
    const active = await prisma.healthScoreConfig.findFirst({ where: { isActive: true }, select: { version: true } });
    await prisma.healthScoreConfig.create({
      data: { version: 1, config: DEFAULT_CONFIG_V1, isActive: !active, note: 'v1 defaults' },
    });
    console.log(`[seed-health-config] version 1 created (${active ? 'inactive: another version is active' : 'active'}).`);
  }
  // Version 2 (same rule as migration 20261108_contract_180): inserted when absent, made active only while
  // version 1 (or nothing) is active, so an OWNER-edited config stays active.
  const v2 = await prisma.healthScoreConfig.findUnique({ where: { version: 2 } });
  if (v2) {
    console.log('[seed-health-config] version 2 already present, nothing to do.');
    return;
  }
  const active = await prisma.healthScoreConfig.findFirst({ where: { isActive: true }, orderBy: { version: 'desc' }, select: { version: true } });
  const activate = !active || active.version === 1;
  await prisma.$transaction([
    ...(activate ? [prisma.healthScoreConfig.updateMany({ where: { isActive: true }, data: { isActive: false } })] : []),
    prisma.healthScoreConfig.create({ data: { version: 2, config: DEFAULT_CONFIG_V2, isActive: activate, note: V2_NOTE } }),
  ]);
  console.log(`[seed-health-config] version 2 created (${activate ? 'active' : 'inactive: an edited version is active'}).`);
}

main()
  .catch((err) => {
    console.error('[seed-health-config] Error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
