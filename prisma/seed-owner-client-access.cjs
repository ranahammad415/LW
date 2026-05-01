/**
 * Optional bulk-link script: add every OWNER user as a MANAGER-role ClientUser
 * for every ClientAccount that currently has no ClientUser row for them.
 *
 * Idempotent: running it again only adds missing links.
 *
 * Usage:  node backend/prisma/seed-owner-client-access.cjs
 *
 * This script is opt-in. It implements the "Owner as Client Manager" bulk
 * migration so the agency owner can act on behalf of every client from day one
 * without hand-linking each account via the admin UI.
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const owners = await prisma.user.findMany({
    where: { role: 'OWNER', isActive: true },
    select: { id: true, email: true, name: true },
  });
  if (owners.length === 0) {
    console.log('No active OWNER users found. Nothing to do.');
    return;
  }

  const clients = await prisma.clientAccount.findMany({
    where: { isActive: true },
    select: { id: true, agencyName: true },
  });
  if (clients.length === 0) {
    console.log('No active clients found. Nothing to do.');
    return;
  }

  let created = 0;
  let skipped = 0;

  for (const owner of owners) {
    for (const client of clients) {
      const existing = await prisma.clientUser.findFirst({
        where: { clientId: client.id, userId: owner.id },
        select: { id: true },
      });
      if (existing) {
        skipped += 1;
        continue;
      }
      await prisma.clientUser.create({
        data: {
          clientId: client.id,
          userId: owner.id,
          role: 'MANAGER',
          isPrimaryContact: false,
          canApproveDeliverables: true,
          canSignContracts: false,
          addedById: owner.id,
          jobTitle: 'Agency Owner',
        },
      });
      created += 1;
      console.log(`Linked OWNER ${owner.email} -> client ${client.agencyName} (${client.id})`);
    }
  }

  console.log(`\nDone. Created ${created} ClientUser rows, skipped ${skipped} already-linked pairs.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
