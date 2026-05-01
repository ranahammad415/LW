require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const rows = await prisma.clientUser.findMany({
    where: { user: { role: 'OWNER' } },
    select: {
      id: true,
      role: true,
      user: { select: { email: true } },
      client: { select: { agencyName: true } },
    },
  });
  console.table(
    rows.map((r) => ({
      id: r.id,
      role: r.role,
      email: r.user.email,
      agencyName: r.client.agencyName,
    }))
  );
  await prisma.$disconnect();
})();