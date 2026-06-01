const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const FEATURES = [
  { key: 'analytics', scopes: ['OWNER', 'PM', 'CLIENT'] },
  { key: 'clients', scopes: ['OWNER'] },
  { key: 'plans', scopes: ['OWNER'] },
  { key: 'projects', scopes: ['OWNER', 'CLIENT'] },
  { key: 'tasks', scopes: ['OWNER', 'PM', 'TEAM_MEMBER', 'CONTRACTOR', 'CLIENT'] },
  { key: 'contentReviews', scopes: ['OWNER'] },
  { key: 'support', scopes: ['OWNER', 'PM', 'TEAM_MEMBER', 'CONTRACTOR', 'CLIENT'] },
  { key: 'meetings', scopes: ['OWNER', 'CLIENT'] },
  { key: 'team', scopes: ['OWNER', 'CLIENT'] },
  { key: 'wpPresets', scopes: ['OWNER'] },
  { key: 'notifications', scopes: ['OWNER'] },
  { key: 'monthlyReports', scopes: ['OWNER', 'PM', 'CLIENT'] },
  { key: 'agencySettings', scopes: ['OWNER'] },
  { key: 'settings', scopes: ['OWNER'] },
  { key: 'inputHub', scopes: ['CLIENT'] },
  { key: 'keywords', scopes: ['CLIENT'] },
  { key: 'activity', scopes: ['CLIENT'] },
  { key: 'standups', scopes: ['PM', 'TEAM_MEMBER', 'CONTRACTOR'] },
  { key: 'reports', scopes: ['PM'] },
  { key: 'dailyDigest', scopes: ['PM'] },
];

const ROLES = ['OWNER', 'PM', 'TEAM_MEMBER', 'CONTRACTOR', 'CLIENT'];

async function main() {
  console.log('[seed-modalities] Seeding default modality configs...');

  for (const feature of FEATURES) {
    for (const role of ROLES) {
      const enabled = feature.scopes.includes(role);
      await prisma.modalityConfig.upsert({
        where: {
          featureKey_role: {
            featureKey: feature.key,
            role,
          },
        },
        create: {
          featureKey: feature.key,
          role,
          enabled,
        },
        update: {
          enabled,
        },
      });
    }
  }

  console.log('[seed-modalities] Done.');
}

main()
  .catch((err) => {
    console.error('[seed-modalities] Error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
