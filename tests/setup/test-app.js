import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';

import { verifyJwt } from '../../src/lib/verifyJwt.js';
import { requireOwner } from '../../src/lib/requireOwner.js';
import { requireClient } from '../../src/lib/requireClient.js';
import { requirePM } from '../../src/lib/requirePM.js';

import { authRoutes } from '../../src/routes/auth.js';
import { userRoutes } from '../../src/routes/users.js';
import { projectRoutes } from '../../src/routes/projects.js';
import { taskRoutes } from '../../src/routes/tasks.js';

import { adminDashboardRoutes } from '../../src/routes/admin/dashboard.js';
import { adminClientRoutes } from '../../src/routes/admin/clients.js';
import { adminUserRoutes } from '../../src/routes/admin/users.js';
import { adminGlobalRoutes } from '../../src/routes/admin/global.js';
import { adminAutomationRoutes } from '../../src/routes/admin/automation.js';
import { adminWpRoutes } from '../../src/routes/admin/wp.js';
import { adminNotificationRoutes } from '../../src/routes/admin/notifications.js';

import { clientDashboardRoutes } from '../../src/routes/client/dashboard.js';
import { clientAnalyticsRoutes } from '../../src/routes/client/analytics.js';
import { clientReportRoutes } from '../../src/routes/client/reports.js';
import { clientTasksRoutes } from '../../src/routes/client/tasks.js';
import { clientProjectsRoutes } from '../../src/routes/client/projects.js';
import { clientInputRoutes } from '../../src/routes/client/inputs.js';
import { clientHubRoutes } from '../../src/routes/client/hub.js';
import { clientOnboardingRoutes } from '../../src/routes/client/onboarding.js';
import { clientRoiRoutes } from '../../src/routes/client/roi.js';
import { clientNovaRoutes } from '../../src/routes/client/nova.js';

import { pmReportRoutes } from '../../src/routes/pm/reports.js';
import { pmStandupRoutes } from '../../src/routes/pm/standups.js';
import { pmChatRoutes } from '../../src/routes/pm/chat.js';
import { pmAlertRoutes } from '../../src/routes/pm/alerts.js';
import { pmTasksRoutes } from '../../src/routes/pm/tasks.js';
import { pmIssueRoutes } from '../../src/routes/pm/issues.js';
import { pmWpRoutes } from '../../src/routes/pm/wp.js';
import { pmKeywordSuggestionRoutes } from '../../src/routes/pm/keywordSuggestions.js';
import { pmPipelineRoutes } from '../../src/routes/pm/pipeline.js';

import { wpWebhookRoutes } from '../../src/routes/webhooks.js';

export async function buildApp() {
  const app = Fastify({ logger: false });

  // Same validator/serializer as production
  app.setValidatorCompiler(() => (data) => ({ value: data }));
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));

  // Plugins (same order as index.js, minus @fastify/static)
  await app.register(cors, {
    origin: true,
    credentials: true,
  });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });
  await app.register(cookie, {
    secret: process.env.JWT_REFRESH_SECRET || 'cookie-secret',
    hook: 'onRequest',
  });

  // Decorators
  app.decorate('verifyJwt', verifyJwt);
  app.decorate('requireOwner', requireOwner);
  app.decorate('requireClient', requireClient);
  app.decorate('requirePM', requirePM);

  // Routes — exact same prefixes as index.js
  app.register(authRoutes, { prefix: '/api/auth' });
  app.register(userRoutes, { prefix: '/api/users' });

  app.register(adminDashboardRoutes, { prefix: '/api/admin' });
  app.register(adminClientRoutes, { prefix: '/api/admin' });
  app.register(adminUserRoutes, { prefix: '/api/admin' });
  app.register(adminGlobalRoutes, { prefix: '/api/admin' });
  app.register(adminAutomationRoutes, { prefix: '/api/admin' });
  app.register(adminWpRoutes, { prefix: '/api/admin' });
  app.register(adminNotificationRoutes, { prefix: '/api/admin' });

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
  app.register(pmChatRoutes, { prefix: '/api/pm' });
  app.register(pmAlertRoutes, { prefix: '/api/pm' });
  app.register(pmTasksRoutes, { prefix: '/api/pm' });
  app.register(pmIssueRoutes, { prefix: '/api/pm' });
  app.register(pmWpRoutes, { prefix: '/api/pm' });
  app.register(pmKeywordSuggestionRoutes, { prefix: '/api/pm' });
  app.register(pmPipelineRoutes, { prefix: '/api/pm' });

  app.register(wpWebhookRoutes, { prefix: '/api/webhooks' });

  // Health check
  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  await app.ready();
  return app;
}
