import 'dotenv/config';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { verifyJwt } from './lib/verifyJwt.js';
import { requireOwner } from './lib/requireOwner.js';
import { requireClient, requireClientWriter } from './lib/requireClient.js';
import { requirePM } from './lib/requirePM.js';
import { adminDashboardRoutes } from './routes/admin/dashboard.js';
import { adminClientRoutes } from './routes/admin/clients.js';
import { adminUserRoutes } from './routes/admin/users.js';
import { adminGlobalRoutes } from './routes/admin/global.js';
import { adminAutomationRoutes } from './routes/admin/automation.js';
import { adminWpRoutes } from './routes/admin/wp.js';
import { adminNotificationRoutes } from './routes/admin/notifications.js';
import { adminAgencySettingsRoutes } from './routes/admin/agency-settings.js';
import { projectRoutes } from './routes/projects.js';
import { taskRoutes } from './routes/tasks.js';
import { clientDashboardRoutes } from './routes/client/dashboard.js';
import { clientAnalyticsRoutes } from './routes/client/analytics.js';
import { clientReportRoutes } from './routes/client/reports.js';
import { clientTasksRoutes } from './routes/client/tasks.js';
import { clientProjectsRoutes } from './routes/client/projects.js';
import { clientInputRoutes } from './routes/client/inputs.js';
import { clientHubRoutes } from './routes/client/hub.js';
import { clientOnboardingRoutes } from './routes/client/onboarding.js';
import { clientRoiRoutes } from './routes/client/roi.js';
import { clientNovaRoutes } from './routes/client/nova.js';
import { pmReportRoutes } from './routes/pm/reports.js';
import { pmStandupRoutes } from './routes/pm/standups.js';
import { pmAlertRoutes } from './routes/pm/alerts.js';
import { pmTasksRoutes } from './routes/pm/tasks.js';
import { pmIssueRoutes } from './routes/pm/issues.js';
import { pmWpRoutes } from './routes/pm/wp.js';
import { pmKeywordSuggestionRoutes } from './routes/pm/keywordSuggestions.js';
import { pmPipelineRoutes } from './routes/pm/pipeline.js';
import { pmDigestRoutes } from './routes/pm/digest.js';
import { pmClientDashboardRoutes } from './routes/pm/clientDashboard.js';
import { wpWebhookRoutes } from './routes/webhooks.js';
import { toolRoutes } from './routes/tool.js';
import cron from 'node-cron';
import { syncAllProjects } from './lib/wpSync.js';
import { runScheduledAeoSweep } from './lib/aeoRunner.js';
import { startPipelineSyncInterval } from './lib/pipelineSync.js';
import { prisma } from './lib/prisma.js';
import { sendEmail, smtpConfigured } from './lib/mailer.js';
import { initGscClient } from './lib/gscClient.js';
import { runGscSync } from './lib/gscSync.js';

const app = Fastify({ logger: true });

// Ensure uploads directory exists
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const UPLOADS_DIR = join(__dirname, '..', 'uploads');
mkdirSync(UPLOADS_DIR, { recursive: true });

// Bypass fastify-type-provider-zod to avoid "reading 'run'" errors — validate in handlers with Zod directly.
app.setValidatorCompiler(() => (data) => ({ value: data }));
app.setSerializerCompiler(() => (data) => JSON.stringify(data));

// CORS configuration - restrict to frontend URL in production
const corsOrigins = process.env.FRONTEND_URL 
  ? [process.env.FRONTEND_URL] 
  : true; // Allow all origins in development

await app.register(cors, {
  origin: corsOrigins,
  credentials: true,
});
await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB
await app.register(fastifyStatic, {
  root: UPLOADS_DIR,
  prefix: '/uploads/',
  decorateReply: false,
});
await app.register(cookie, {
  secret: process.env.JWT_REFRESH_SECRET || 'cookie-secret',
  hook: 'onRequest',
});

app.decorate('verifyJwt', verifyJwt);
app.decorate('requireOwner', requireOwner);
app.decorate('requireClient', requireClient);
app.decorate('requireClientWriter', requireClientWriter);
app.decorate('requirePM', requirePM);

app.register(authRoutes, { prefix: '/api/auth' });
app.register(userRoutes, { prefix: '/api/users' });
app.register(adminDashboardRoutes, { prefix: '/api/admin' });
app.register(adminClientRoutes, { prefix: '/api/admin' });
app.register(adminUserRoutes, { prefix: '/api/admin' });
app.register(adminGlobalRoutes, { prefix: '/api/admin' });
app.register(adminAutomationRoutes, { prefix: '/api/admin' });
app.register(adminWpRoutes, { prefix: '/api/admin' });
app.register(adminNotificationRoutes, { prefix: '/api/admin' });
app.register(adminAgencySettingsRoutes, { prefix: '/api/admin' });
app.register(projectRoutes, { prefix: '/api/projects' });
app.register(taskRoutes, { prefix: '/api/tasks' });
app.register(clientDashboardRoutes, { prefix: '/api/client' });
app.register(clientAnalyticsRoutes, { prefix: '/api/client' });
app.register(clientReportRoutes, { prefix: '/api/client' });
app.register(clientTasksRoutes, { prefix: '/api/client' });
app.register(clientProjectsRoutes, { prefix: '/api/client' });
app.register(clientInputRoutes, { prefix: '/api/client' });
app.register(clientHubRoutes, { prefix: '/api/client' });
app.register(clientOnboardingRoutes, { prefix: '/api/client' });
app.register(clientRoiRoutes, { prefix: '/api/client' });
app.register(clientNovaRoutes, { prefix: '/api/client' });
app.register(pmReportRoutes, { prefix: '/api/pm' });
app.register(pmStandupRoutes, { prefix: '/api/pm' });
app.register(pmAlertRoutes, { prefix: '/api/pm' });
app.register(pmTasksRoutes, { prefix: '/api/pm' });
app.register(pmIssueRoutes, { prefix: '/api/pm' });
app.register(pmWpRoutes, { prefix: '/api/pm' });
app.register(pmKeywordSuggestionRoutes, { prefix: '/api/pm' });
app.register(pmPipelineRoutes, { prefix: '/api/pm' });
app.register(pmDigestRoutes, { prefix: '/api/pm' });
app.register(pmClientDashboardRoutes, { prefix: '/api/pm' });
app.register(wpWebhookRoutes, { prefix: '/api/webhooks' });
app.register(toolRoutes, { prefix: '/api/tool' });

app.get('/health', async (req) => {
  req.log.info('Health check hit');
  return { status: 'ok', timestamp: new Date().toISOString() };
});

const port = Number(process.env.PORT) || 3000;
try {
  // Initialize GSC client (no-op if env var not set)
  const gscOk = await initGscClient();
  if (gscOk) app.log.info('Google Search Console integration enabled');

  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`App started on port ${port}`);

  cron.schedule('0 3 * * *', async () => {
    app.log.info('Starting daily WP page sync for all projects...');
    try {
      const results = await syncAllProjects();
      app.log.info({ results }, 'Daily WP page sync complete');
    } catch (err) {
      app.log.error({ err }, 'Daily WP page sync failed');
    }
  });

  // AEO automated sweep — runs daily at 04:00 UTC
  cron.schedule('0 4 * * *', async () => {
    app.log.info('Starting daily AEO automated sweep...');
    try {
      const summary = await runScheduledAeoSweep();
      app.log.info({ summary }, 'Daily AEO sweep complete');
    } catch (err) {
      app.log.error({ err }, 'Daily AEO sweep failed');
    }
  });

  // Pipeline sync — configurable interval from .env
  startPipelineSyncInterval(app.log);

  // GSC metrics sync — runs daily at 05:00 UTC
  cron.schedule('0 5 * * *', async () => {
    app.log.info('Starting daily GSC metrics sync...');
    try {
      const result = await runGscSync();
      app.log.info({ result }, 'Daily GSC metrics sync complete');
    } catch (err) {
      app.log.error({ err }, 'Daily GSC metrics sync failed');
    }
  });

  // Daily notification digest — runs at 08:00 UTC
  cron.schedule('0 8 * * *', async () => {
    app.log.info('Starting daily notification digest...');
    try {
      if (!smtpConfigured) {
        app.log.info('SMTP not configured — skipping digest');
        return;
      }
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      // Get users with unread notifications in the last 24h
      const usersWithUnread = await prisma.notificationLog.groupBy({
        by: ['recipientId'],
        where: {
          createdAt: { gte: yesterday },
          isRead: false,
        },
        _count: { id: true },
      });

      let digestsSent = 0;
      for (const group of usersWithUnread) {
        if (group._count.id < 2) continue; // Only send digest if 2+ unread
        const user = await prisma.user.findUnique({
          where: { id: group.recipientId },
          select: { id: true, email: true, name: true, isActive: true },
        });
        if (!user || !user.isActive) continue;

        const logs = await prisma.notificationLog.findMany({
          where: {
            recipientId: user.id,
            createdAt: { gte: yesterday },
            isRead: false,
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        });

        const listItems = logs.map((l) => `<li>${l.message}</li>`).join('');
        const html = `<p>Hi ${user.name || 'there'},</p><p>You have ${group._count.id} unread notifications:</p><ul>${listItems}</ul><p>Log in to see details.</p>`;

        await sendEmail({
          to: user.email,
          subject: `You have ${group._count.id} unread notifications`,
          html,
        });
        digestsSent++;
      }
      app.log.info({ digestsSent }, 'Daily notification digest complete');
    } catch (err) {
      app.log.error({ err }, 'Daily notification digest failed');
    }
  });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

