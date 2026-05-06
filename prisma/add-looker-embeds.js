import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../.env') });

const prisma = new PrismaClient();

const LOOKER_REPORT_URL = 'https://lookerstudio.google.com/embed/reporting/66d7bd70-2a13-4b8a-8110-24687d8934a0/page/p_8jvxmorodd';
const LABEL = 'Analytics Dashboard';

async function main() {
  const clients = await prisma.clientAccount.findMany({
    select: { id: true, agencyName: true },
  });

  console.log(`Found ${clients.length} clients. Adding Looker embeds...\n`);

  for (const client of clients) {
    // Skip if this client already has this embed URL
    const existing = await prisma.lookerEmbed.findFirst({
      where: { clientId: client.id, url: LOOKER_REPORT_URL },
    });
    if (existing) {
      console.log(`  [SKIP] ${client.agencyName} — already has this embed`);
      continue;
    }

    await prisma.lookerEmbed.create({
      data: {
        clientId: client.id,
        label: LABEL,
        url: LOOKER_REPORT_URL,
        sortOrder: 0,
        isActive: true,
      },
    });
    console.log(`  [OK]   ${client.agencyName} — embed added`);
  }

  console.log('\nDone!');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
