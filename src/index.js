import 'dotenv/config';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
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
import { adminActivityReportRoutes } from './routes/admin/activity-reports.js';
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
import { realtimeRoutes } from './routes/realtime.js';
import { toolRoutes } from './routes/tool.js';
import omniSearchRoutes from './routes/omniSearch/index.js';
import { adminAiUsageRoutes } from './routes/admin/ai-usage.js';
import { pmInputRequestRoutes } from './routes/pm/inputRequests.js';
import cron from 'node-cron';
import { syncAllProjects } from './lib/wpSync.js';
import { runScheduledAeoSweep } from './lib/aeoRunner.js';
import { startPipelineSyncInterval } from './lib/pipelineSync.js';
import { prisma } from './lib/prisma.js';
import { sendEmail, smtpConfigured } from './lib/mailer.js';
import { initGscClient } from './lib/gscClient.js';
import { runGscSync } from './lib/gscSync.js';
import { initSentry } from './lib/sentry.js';
import { runWeeklyClientDigest } from './lib/weeklyDigest.js';

// ── Startup secret validation (fail-fast) ─────────────────────────────────
const REQUIRED_SECRETS = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'COOKIE_SECRET'];
for (const key of REQUIRED_SECRETS) {
  const v = process.env[key];
  if (!v || v.length < 32) {
    // eslint-disable-next-line no-console
    console.error(`[startup] ${key} is missing or shorter than 32 chars — refusing to start.`);
    process.exit(1);
  }
}
if (
  process.env.COOKIE_SECRET === process.env.JWT_ACCESS_SECRET ||
  process.env.COOKIE_SECRET === process.env.JWT_REFRESH_SECRET ||
  process.env.JWT_ACCESS_SECRET === process.env.JWT_REFRESH_SECRET
) {
  // eslint-disable-next-line no-console
  console.error('[startup] JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, and COOKIE_SECRET must all differ.');
  process.exit(1);
}

const TRUST_PROXY = String(process.env.TRUST_PROXY || '').toLowerCase() === 'true';
const app = Fastify({ logger: true, trustProxy: TRUST_PROXY });

// Ensure uploads directory exists
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const UPLOADS_DIR = join(__dirname, '..', 'uploads');
mkdirSync(UPLOADS_DIR, { recursive: true });

// Bypass fastify-type-provider-zod to avoid "reading 'run'" errors — validate in handlers with Zod directly.
app.setValidatorCompiler(() => (data) => ({ value: data }));
app.setSerializerCompiler(() => (data) => JSON.stringify(data));

// Security headers (register before CORS so preflight responses still include CORS headers).
await app.register(helmet, {
  // We serve uploads from the same origin; keep CSP conservative but don't break API clients.
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});

// Global rate limit (per-route overrides — e.g. /api/auth/login — live on the route configs).
await app.register(rateLimit, {
  global: true,
  max: Number(process.env.RATE_LIMIT_GLOBAL_MAX || 300),
  timeWindow: process.env.RATE_LIMIT_GLOBAL_WINDOW || '1 minute',
  allowList: (req) => req.url === '/health',
});

// CORS — fail-closed in production when FRONTEND_URL is not set.
const frontendUrl = process.env.FRONTEND_URL;
let corsOrigins;
if (frontendUrl) {
  corsOrigins = frontendUrl
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
} else if (process.env.NODE_ENV === 'production') {
  // eslint-disable-next-line no-console
  console.error('[startup] FRONTEND_URL is required in production — refusing to start.');
  process.exit(1);
} else {
  corsOrigins = true; // dev only
}

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
  secret: process.env.COOKIE_SECRET,
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
app.register(adminActivityReportRoutes, { prefix: '/api/admin' });
app.register(adminAiUsageRoutes, { prefix: '/api/admin' });
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
app.register(pmInputRequestRoutes, { prefix: '/api/pm' });
app.register(wpWebhookRoutes, { prefix: '/api/webhooks' });
app.register(realtimeRoutes, { prefix: '/api/realtime' });
app.register(toolRoutes, { prefix: '/api/tool' });
app.register(omniSearchRoutes, { prefix: '/api/omni-search' });

app.get('/health', async (req, reply) => {
  req.log.info('Health check hit');
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', timestamp: new Date().toISOString() };
  } catch (err) {
    req.log.error({ err }, 'Health check DB probe failed');
    return reply.code(503).send({ status: 'degraded', db: 'down', timestamp: new Date().toISOString() });
  }
});

const port = Number(process.env.PORT) || 3000;
try {
  // Initialize Sentry (no-op if SENTRY_DSN not set)
  await initSentry(app.log);

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

  // Weekly AI client digest — runs Monday 08:00 UTC
  cron.schedule('0 8 * * 1', async () => {
    app.log.info('Starting weekly AI client digest...');
    try {
      const summary = await runWeeklyClientDigest(app.log);
      app.log.info({ summary }, 'Weekly AI client digest complete');
    } catch (err) {
      app.log.error({ err }, 'Weekly AI client digest failed');
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

// ── Graceful shutdown ──────────────────────────────────────────────────────
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Shutdown signal received — closing server');
  try {
    await app.close();
    await prisma.$disconnect();
    app.log.info('Shutdown complete');
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => shutdown(sig));
}
process.on('unhandledRejection', (reason) => {
  app.log.error({ reason }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  app.log.error({ err }, 'Uncaught exception — exiting');
  process.exit(1);
});

