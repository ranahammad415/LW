const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const logs = await prisma.notificationLog.findMany({
    where: { templateSlug: 'content_ready_for_client_review' },
    orderBy: { createdAt: 'desc' },
    take: 4,
    select: { recipientId: true, emailError: true, emailDeferred: true, emailSentAt: true, createdAt: true },
  });
  console.log('Recent pipeline email results:');
  logs.forEach(l => {
    console.log(`  deferred=${l.emailDeferred} sent=${!!l.emailSentAt} error="${l.emailError || 'none'}" at=${l.createdAt}`);
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());
