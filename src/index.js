import './loadEnv.js';
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
import { adminProjectHtmlReportRoutes } from './routes/admin/project-html-reports.js';
import { adminGoogleExtractRoutes } from './routes/admin/googleExtract.js';
import { adminAgencyImportRoutes } from './routes/admin/agencyImport.js';
import { adminBacklinkRoutes } from './routes/admin/backlinks.js';
import { adminWorkCycleRoutes } from './routes/admin/workCycles.js';
import { adminNextMonthRoutes } from './routes/admin/nextMonth.js';
import { workCycleRoutes } from './routes/workCycles.js';
import { projectRoutes } from './routes/projects.js';
import { taskRoutes } from './routes/tasks.js';
import { clientDashboardRoutes } from './routes/client/dashboard.js';
import { clientAnalyticsRoutes } from './routes/client/analytics.js';
import { clientReportRoutes } from './routes/client/reports.js';
import { clientTasksRoutes } from './routes/client/tasks.js';
import { clientProjectsRoutes } from './routes/client/projects.js';
import { clientBacklinkRoutes } from './routes/client/backlinks.js';
import { clientInputRoutes } from './routes/client/inputs.js';
import { clientHubRoutes } from './routes/client/hub.js';
import { clientOnboardingRoutes } from './routes/client/onboarding.js';
import { clientKnowledgeRoutes, staffKnowledgeRoutes } from './routes/client/knowledge.js';
import { clientOkfRoutes, staffOkfRoutes } from './routes/client/okf.js';
import { staffKnowledgeClientRoutes } from './routes/staff/knowledgeClients.js';
import { staffKnowledgeInviteRoutes } from './routes/staff/knowledgeInvites.js';
import { publicKnowledgeInterviewRoutes } from './routes/publicKnowledgeInterview.js';
import {
  clientKnowledgeCrawlRoutes,
  staffKnowledgeCrawlRoutes,
} from './routes/staff/knowledgeCrawl.js';
import { clientGapInterviewRoutes } from './routes/client/gapInterview.js';
import { clientVoiceAgentRoutes } from './routes/client/voiceAgent.js';
import { clientContentMapRoutes } from './routes/client/contentMap.js';
import { clientRoiRoutes } from './routes/client/roi.js';
import { clientNovaRoutes } from './routes/client/nova.js';
import { pmReportRoutes } from './routes/pm/reports.js';
import { pmProjectHtmlReportRoutes } from './routes/pm/project-html-reports.js';
import { pmStandupRoutes } from './routes/pm/standups.js';
import { pmAlertRoutes } from './routes/pm/alerts.js';
import { pmOkfReviewRoutes } from './routes/pm/okfReview.js';
import { pmTasksRoutes } from './routes/pm/tasks.js';
import { pmIssueRoutes } from './routes/pm/issues.js';
import { pmWpRoutes } from './routes/pm/wp.js';
import { pmKeywordSuggestionRoutes } from './routes/pm/keywordSuggestions.js';
import { pmPipelineRoutes } from './routes/pm/pipeline.js';
import { pmContentMapRoutes } from './routes/pm/contentMap.js';
import { pmDigestRoutes } from './routes/pm/digest.js';
import { pmClientDashboardRoutes } from './routes/pm/clientDashboard.js';
import { wpWebhookRoutes } from './routes/webhooks.js';
import { realtimeRoutes } from './routes/realtime.js';
import { toolRoutes } from './routes/tool.js';
import omniSearchRoutes from './routes/omniSearch/index.js';
import { adminAiUsageRoutes } from './routes/admin/ai-usage.js';
import { adminIntegrationsRoutes } from './routes/admin/integrations.js';
import { adminAnalyticsRoutes } from './routes/admin/analytics.js';
import { pmInputRequestRoutes } from './routes/pm/inputRequests.js';
import { modalityRoutes } from './routes/modalityRoutes.js';
import { publicIssuesRoutes } from './routes/publicIssues.js';
import cron from 'node-cron';
import { syncAllProjects } from './lib/wpSync.js';
import { runScheduledAeoSweep } from './lib/aeoRunner.js';
import { startPipelineSyncInterval } from './lib/pipelineSync.js';
import { prisma } from './lib/prisma.js';
import { sendEmail, smtpConfigured } from './lib/mailer.js';
import { initGscClient } from './lib/gscClient.js';
import { runGscSync } from './lib/gscSync.js';
import { runNativeAnalyticsSync } from './lib/analytics/runNativeSync.js';
import { initSentry } from './lib/sentry.js';
import { runWeeklyClientDigest } from './lib/weeklyDigest.js';
import { runScheduledTaskSync } from './lib/dataImport/scheduledSync.js';

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
app.register(adminProjectHtmlReportRoutes, { prefix: '/api/admin' });
app.register(adminGoogleExtractRoutes, { prefix: '/api/admin' });
app.register(adminAgencyImportRoutes, { prefix: '/api/admin' });
app.register(adminBacklinkRoutes, { prefix: '/api/admin' });
app.register(adminWorkCycleRoutes, { prefix: '/api/admin' });
app.register(adminNextMonthRoutes, { prefix: '/api/admin' });
app.register(adminAiUsageRoutes, { prefix: '/api/admin' });
app.register(adminIntegrationsRoutes, { prefix: '/api/admin' });
app.register(adminAnalyticsRoutes, { prefix: '/api/admin' });
app.register(projectRoutes, { prefix: '/api/projects' });
app.register(taskRoutes, { prefix: '/api/tasks' });
app.register(clientDashboardRoutes, { prefix: '/api/client' });
app.register(clientAnalyticsRoutes, { prefix: '/api/client' });
app.register(clientReportRoutes, { prefix: '/api/client' });
app.register(clientTasksRoutes, { prefix: '/api/client' });
app.register(clientProjectsRoutes, { prefix: '/api/client' });
app.register(clientBacklinkRoutes, { prefix: '/api/client' });
app.register(clientInputRoutes, { prefix: '/api/client' });
app.register(clientHubRoutes, { prefix: '/api/client' });
app.register(clientOnboardingRoutes, { prefix: '/api/client' });
app.register(clientKnowledgeRoutes, { prefix: '/api/client' });
app.register(clientOkfRoutes, { prefix: '/api/client' });
app.register(clientKnowledgeCrawlRoutes, { prefix: '/api/client' });
app.register(clientGapInterviewRoutes, { prefix: '/api/client' });
app.register(clientVoiceAgentRoutes, { prefix: '/api/client' });
app.register(clientContentMapRoutes, { prefix: '/api/client' });
app.register(clientRoiRoutes, { prefix: '/api/client' });
app.register(clientNovaRoutes, { prefix: '/api/client' });
app.register(pmReportRoutes, { prefix: '/api/pm' });
app.register(pmProjectHtmlReportRoutes, { prefix: '/api/pm' });
app.register(pmStandupRoutes, { prefix: '/api/pm' });
app.register(pmAlertRoutes, { prefix: '/api/pm' });
app.register(pmOkfReviewRoutes, { prefix: '/api/pm' });
// Same knowledge handlers as the client mount, addressed by client id and
// scoped by role: Owner read/write on any client, PM read-only on their own.
app.register(staffKnowledgeClientRoutes, { prefix: '/api/staff' });
app.register(staffKnowledgeCrawlRoutes, { prefix: '/api/staff' });
app.register(staffKnowledgeInviteRoutes, { prefix: '/api/staff' });
app.register(staffKnowledgeRoutes, { prefix: '/api/staff' });
app.register(staffOkfRoutes, { prefix: '/api/staff' });
app.register(pmTasksRoutes, { prefix: '/api/pm' });
app.register(pmIssueRoutes, { prefix: '/api/pm' });
app.register(pmWpRoutes, { prefix: '/api/pm' });
app.register(pmKeywordSuggestionRoutes, { prefix: '/api/pm' });
app.register(pmPipelineRoutes, { prefix: '/api/pm' });
app.register(pmContentMapRoutes, { prefix: '/api/pm' });
app.register(pmDigestRoutes, { prefix: '/api/pm' });
app.register(pmClientDashboardRoutes, { prefix: '/api/pm' });
app.register(pmInputRequestRoutes, { prefix: '/api/pm' });
app.register(modalityRoutes, { prefix: '/api' });
app.register(workCycleRoutes, { prefix: '/api/work-cycles' });
app.register(publicIssuesRoutes, { prefix: '/api/public' });
app.register(publicKnowledgeInterviewRoutes, { prefix: '/api/public' });
app.register(wpWebhookRoutes, { prefix: '/api/webhooks' });
app.register(realtimeRoutes, { prefix: '/api/realtime' });
app.register(toolRoutes, { prefix: '/api/tool' });
// OmniSearch is a large, self-contained sub-app kept hidden by default to reduce
// product surface. Enable explicitly with OMNISEARCH_ENABLED=true.
const OMNISEARCH_ENABLED = String(process.env.OMNISEARCH_ENABLED || '').toLowerCase() === 'true';
if (OMNISEARCH_ENABLED) {
  app.register(omniSearchRoutes, { prefix: '/api/omni-search' });
  app.log.info('OmniSearch routes enabled');
}

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

  // Scheduled sheet → OS task sync (keeps task status/comments fresh for the
  // current monthly session). Opt-in via TASK_SYNC_ENABLED=true.
  if (String(process.env.TASK_SYNC_ENABLED || '').toLowerCase() === 'true') {
    const taskSyncCron = process.env.TASK_SYNC_CRON || '0 2 * * *';
    cron.schedule(taskSyncCron, async () => {
      app.log.info('Starting scheduled task sync from sheets...');
      try {
        const summary = await runScheduledTaskSync({ log: app.log });
        app.log.info({ totals: summary.totals }, 'Scheduled task sync complete');
      } catch (err) {
        app.log.error({ err }, 'Scheduled task sync failed');
      }
    });
    app.log.info({ taskSyncCron }, 'Scheduled task sync enabled');
  }

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

  // GA4 + GMB + DataForSEO sync — runs daily at 05:30 UTC
  cron.schedule('30 5 * * *', async () => {
    app.log.info('Starting native analytics sync (GA4/GMB/DataForSEO)...');
    try {
      const result = await runNativeAnalyticsSync(app.log);
      app.log.info({ result }, 'Native analytics sync complete');
    } catch (err) {
      app.log.error({ err }, 'Native analytics sync failed');
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

  // Daily notification digest ("You have N unread notifications" email) —
  // DISABLED per request. These digest emails are no longer sent. The in-app
  // notifications are unaffected; only the daily summary email is turned off.
  // To re-enable, restore the cron.schedule('0 8 * * *', ...) block from history.
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

