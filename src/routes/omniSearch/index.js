import authRoutes from './auth.js';
import researchRoutes from './research.js';
import contentRoutes from './content.js';
import writingRoutes from './writing.js';
import rankingsRoutes from './rankings.js';
import technicalRoutes from './technical.js';
import backlinksRoutes from './backlinks.js';
import geoRoutes from './geo.js';
import localSeoRoutes from './localSeo.js';
import analyticsRoutes from './analytics.js';
import agencyRoutes from './agency.js';
import advisorRoutes from './advisor.js';
import automationRoutes from './automation.js';
import linkBuildingRoutes from './linkBuilding.js';
import collaborationRoutes from './collaboration.js';
import { registerOmniSearchSentryHook } from '../../lib/sentry.js';

export default async function omniSearchRoutes(app) {
  // Forward any unhandled OmniSearch route error to Sentry (no-op if SENTRY_DSN not set)
  registerOmniSearchSentryHook(app);

  // Auth must register first so it decorates app.omniSearchAuth
  app.register(authRoutes);

  // Feature route groups
  app.register(researchRoutes);
  app.register(contentRoutes);
  app.register(writingRoutes);
  app.register(rankingsRoutes);
  app.register(technicalRoutes);
  app.register(backlinksRoutes);
  app.register(geoRoutes);
  app.register(localSeoRoutes);
  app.register(analyticsRoutes);
  app.register(agencyRoutes);
  app.register(advisorRoutes);
  app.register(automationRoutes);
  app.register(linkBuildingRoutes);
  app.register(collaborationRoutes);
}
