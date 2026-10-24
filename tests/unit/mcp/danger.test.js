/**
 * MCP danger classification (src/mcp/danger.js): table over the five levels, incl. body-key and status rules,
 * blocked prefixes / routes / secret fields / encoded paths, the explicit critical list, costly and bulk.
 */
import { describe, it, expect } from 'vitest';
import { classifyRequest, EXPLICIT_CRITICAL, BLOCKED_ROUTES } from '../../../src/mcp/danger.js';

const c = (method, routePattern, extra = {}) => classifyRequest({ method, routePattern, path: extra.path || routePattern, query: extra.query, body: extra.body, routeConfig: extra.routeConfig });

const TABLE = [
  // ── read
  ['GET', '/api/users/me', {}, 'read'],
  ['GET', '/api/admin/dashboard', {}, 'read'],
  ['GET', '/api/admin/clients', {}, 'read'],
  ['GET', '/api/admin/clients/:id', {}, 'read'],
  ['GET', '/api/tasks', {}, 'read'],
  ['GET', '/api/tasks/', {}, 'read'],
  ['GET', '/api/tasks/:id/comments', {}, 'read'],
  ['GET', '/api/projects/:id', {}, 'read'],
  ['GET', '/api/pm/alerts', {}, 'read'],
  ['GET', '/api/pm/projects/:projectId/cms-leads', {}, 'read'],
  ['GET', '/api/admin/team/workload', {}, 'read'],
  ['HEAD', '/api/tasks', {}, 'read'],
  // ── write
  ['POST', '/api/tasks', { body: { projectId: 'p', title: 't', taskType: 'general' } }, 'write'],
  ['PATCH', '/api/tasks/:id', { body: { title: 'x' } }, 'write'],
  ['PATCH', '/api/tasks/:id/status', { body: { status: 'IN_PROGRESS' } }, 'write'],
  ['PATCH', '/api/tasks/:id/status', { body: { status: 'NEEDS_REVIEW' } }, 'write'],
  ['POST', '/api/tasks/:id/comments', { body: { content: 'hi' } }, 'write'],
  ['POST', '/api/pm/standups', { body: { notes: 'x' } }, 'write'],
  ['PATCH', '/api/pm/cms-drafts/:id', { body: { title: 'x' } }, 'write'],
  ['POST', '/api/tasks/:id/dependencies', { body: { dependencyIds: ['a'] } }, 'write'],
  ['PATCH', '/api/admin/clients/:id', { body: { industry: 'dental' } }, 'write'],
  // ── dangerous: method / path segment
  ['DELETE', '/api/tasks/:id', {}, 'dangerous'],
  ['DELETE', '/api/tasks/:taskId/comments/:commentId', {}, 'dangerous'],
  ['PATCH', '/api/admin/packages/:id', { body: { name: 'x' } }, 'dangerous'],
  ['POST', '/api/admin/api-tokens/:id/revoke', {}, 'dangerous'],
  ['POST', '/api/pm/projects/:projectId/cms-leads/:leadId/external-erased', {}, 'dangerous'],
  // ── dangerous: body keys (plans, ownership, sender identity, other hosts)
  ['PATCH', '/api/admin/clients/:id', { body: { packageId: 'x' } }, 'dangerous'],
  ['PATCH', '/api/admin/clients/:id', { body: { isActive: false } }, 'dangerous'],
  ['PATCH', '/api/admin/clients/:id', { body: { leadPmId: 'u' } }, 'dangerous'],
  ['PATCH', '/api/admin/clients/:id', { body: { websiteUrl: 'https://x.test' } }, 'dangerous'],
  ['PATCH', '/api/admin/agency-settings', { body: { emailHeaderHtml: '<img src=x>' } }, 'dangerous'],
  ['PATCH', '/api/admin/agency-settings', { body: { emailFooterHtml: 'x' } }, 'dangerous'],
  ['PATCH', '/api/admin/agency-settings', { body: { emailFromAddress: 'a@b.c' } }, 'dangerous'],
  ['PATCH', '/api/admin/agency-settings', { body: { logoUrl: 'https://x.test/l.png' } }, 'dangerous'],
  // ── dangerous: notification / email templates and content (re-review N1)
  ['PATCH', '/api/admin/notifications/templates/:id', { body: { isActive: true } }, 'dangerous'],
  ['PATCH', '/api/admin/notifications/templates/:id', { body: { subject: 'Hi', bodyHtml: '<a href=x>' } }, 'dangerous'],
  ['PUT', '/api/admin/notifications/templates/:id/variants/:audience', { body: { bodyText: 'x' } }, 'dangerous'],
  ['DELETE', '/api/admin/notifications/templates/:id/variants/:audience', {}, 'dangerous'],
  ['POST', '/api/admin/notifications/templates/:id/variants/:audience/test', {}, 'dangerous'],
  ['POST', '/api/admin/notifications/test/:slug', {}, 'dangerous'],
  ['PATCH', '/api/x/emails/:id', { body: { subject: 'x' } }, 'dangerous'],
  ['PATCH', '/api/x/digest-settings', { body: { bodyHtml: 'x' } }, 'dangerous'],
  ['PATCH', '/api/tasks/:id', { body: { subject: 'x' } }, 'write'],
  ['POST', '/api/pm/cms-drafts/:id/notes', { body: { bodyHtml: 'x' } }, 'write'],
  // ── dangerous: explicit HUMAN_ONLY / approval list
  ['POST', '/api/pm/pipeline/:projectId/:wpPipelineId/review', {}, 'dangerous'],
  ['POST', '/api/pm/pipeline/:projectId/:wpPipelineId/client-review', {}, 'dangerous'],
  ['PATCH', '/api/pm/keyword-suggestions/:id/approve', {}, 'dangerous'],
  ['POST', '/api/pm/okf-review/drafts/:id/reject', {}, 'dangerous'],
  ['PATCH', '/api/pm/reports/:id/approve', {}, 'dangerous'],
  ['PATCH', '/api/projects/:id/keywords/:keywordId/accept-edit', {}, 'dangerous'],
  ['POST', '/api/pm/security/projects/:projectId/ack', {}, 'dangerous'],
  ['PATCH', '/api/admin/security-settings', { body: { retentionDays: 100 } }, 'dangerous'],
  ['PUT', '/api/pm/clients/:clientId/health-note', { body: { note: 'x' } }, 'dangerous'],
  ['PUT', '/api/admin/health/config', { body: {} }, 'dangerous'],
  ['PUT', '/api/pm/projects/:id/local-seo/location', { body: {} }, 'dangerous'],
  ['POST', '/api/pm/signals/projects/:projectId/config', { body: {} }, 'dangerous'],
  ['POST', '/api/admin/work-cycles/open-next', {}, 'dangerous'],
  ['POST', '/api/admin/projects/:id/next-month/prepare', {}, 'dangerous'],
  ['POST', '/api/admin/integrations/google/disconnect', { body: {} }, 'dangerous'],
  ['PATCH', '/api/tasks/:id/status', { body: { status: 'COMPLETED' } }, 'dangerous'],
  ['PATCH', '/api/tasks/:id/status', { body: { status: 'cancelled' } }, 'dangerous'],
  // ── dangerous: bulk
  ['POST', '/api/projects/:id/tasks/bulk', { body: { tasks: [] } }, 'dangerous'],
  ['POST', '/api/pm/content-maps/:mapId/drift/bulk', { body: {} }, 'dangerous'],
  ['PATCH', '/api/tasks/:id', { body: { assigneeIds: Array.from({ length: 21 }, (_, i) => `u${i}`) } }, 'dangerous'],
  ['PATCH', '/api/tasks/:id', { body: { assigneeIds: Array.from({ length: 20 }, (_, i) => `u${i}`) } }, 'write'],
  // ── dangerous: costly (paid AI / DataForSEO / site), incl. review M2 routes
  ['POST', '/api/pm/cms-drafts/:id/ai-write', {}, 'dangerous'],
  ['POST', '/api/pm/pipeline/sync', {}, 'dangerous'],
  ['POST', '/api/pm/projects/:projectId/health/recompute', {}, 'dangerous'],
  ['POST', '/api/projects/:id/suggest-tasks', {}, 'dangerous'],
  ['POST', '/api/pm/projects/:id/prioritize-tasks', {}, 'dangerous'],
  ['POST', '/api/client/nova/chat', { body: { message: 'x' } }, 'dangerous'],
  ['POST', '/api/pm/input-requests/:id/draft', {}, 'dangerous'],
  ['POST', '/api/pm/projects/:id/page-speed/refresh', {}, 'dangerous'],
  ['POST', '/api/staff/clients/:clientId/knowledge/crawl', {}, 'dangerous'],
  ['POST', '/api/staff/clients/:clientId/knowledge/article', { body: { topic: 'x' } }, 'dangerous'],
  ['POST', '/api/staff/clients/:clientId/knowledge/opportunities', {}, 'dangerous'],
  ['POST', '/api/staff/clients/:clientId/knowledge/strategy', {}, 'dangerous'],
  ['POST', '/api/staff/clients/:clientId/knowledge/reindex', {}, 'dangerous'],
  ['POST', '/api/staff/clients/:clientId/knowledge/profile', {}, 'dangerous'],
  ['POST', '/api/staff/clients/:clientId/knowledge/interview/turn', {}, 'dangerous'],
  ['POST', '/api/staff/clients/:clientId/knowledge/interview/followup', {}, 'dangerous'],
  ['POST', '/api/staff/clients/:clientId/intake/orchestrate', {}, 'dangerous'],
  ['POST', '/api/client/knowledge/article', {}, 'dangerous'],
  ['POST', '/api/admin/project-html-reports', {}, 'dangerous'],
  ['POST', '/api/pm/clients/:clientId/pm-update', { body: { message: 'x' } }, 'dangerous'],
  ['POST', '/api/admin/automation/aeo-sweep', {}, 'dangerous'],
  ['POST', '/api/admin/analytics/:clientId/ai-html-report', {}, 'dangerous'],
  ['POST', '/api/admin/integrations/health/probe-gmb', {}, 'dangerous'],
  ['POST', '/api/client/voice-agent/session', {}, 'dangerous'],
  ['POST', '/api/pm/projects/:id/citations/check', {}, 'dangerous'],
  ['POST', '/api/admin/activity-reports/generate', {}, 'dangerous'],
  ['GET', '/api/pm/projects/:projectId/site-metrics', { query: { refresh: 'true' } }, 'dangerous'],
  ['GET', '/api/pm/projects/:projectId/site-metrics', { query: { refresh: 'false' } }, 'read'],
  ['POST', '/api/x/marked', { routeConfig: { mcp: 'costly' } }, 'dangerous'],
  ['GET', '/api/x/marked', { routeConfig: { mcp: 'costly' } }, 'dangerous'],
  // ── critical (owner approval in the OS UI)
  ['POST', '/api/admin/interviews/invites/:id/revoke', {}, 'critical'],
  ['POST', '/api/admin/interviews/invites/:id/resend', {}, 'critical'],
  ['POST', '/api/admin/interviews/invites', { body: { clientIds: ['c'] } }, 'critical'],
  ['POST', '/api/staff/clients/:clientId/knowledge/invites', { body: {} }, 'critical'],
  ['POST', '/api/pm/pipeline/:projectId/:wpPipelineId/publish', {}, 'critical'],
  ['POST', '/api/pm/pipeline/:projectId/:wpPipelineId/schedule', {}, 'critical'],
  ['POST', '/api/pm/pipeline/:projectId/:wpPipelineId/unschedule', {}, 'critical'],
  ['POST', '/api/admin/clients/:id/users', { body: { name: 'x' } }, 'critical'],
  ['PATCH', '/api/admin/clients/:id/users/:userId', { body: { name: 'x' } }, 'critical'],
  ['POST', '/api/admin/team/members', { body: { name: 'x' } }, 'critical'],
  ['PATCH', '/api/admin/team/members/:id', { body: { name: 'x' } }, 'critical'],
  ['POST', '/api/admin/notifications/send-test-email', { body: { to: 'a' } }, 'critical'],
  ['POST', '/api/pm/projects/:projectId/cms-leads/:leadId/erase', {}, 'critical'],
  ['POST', '/api/pm/signals/projects/:projectId/erase', { body: { visitorId: 'v' } }, 'critical'],
  ['POST', '/api/projects/:id/cms/migration/apply', { body: {} }, 'critical'],
  ['POST', '/api/projects/:id/cms/disconnect', {}, 'critical'],
  ['PATCH', '/api/projects/:id', { body: { wpUrl: 'https://evil.example' } }, 'critical'],
  ['PATCH', '/api/projects/:id', { body: { siteUrl: 'https://evil.example' } }, 'critical'],
  ['PATCH', '/api/projects/:id', { body: { cmsType: 'EMDASH' } }, 'critical'],
  ['PATCH', '/api/admin/security-settings', { body: { slackWebhookUrl: 'https://hooks.example' } }, 'critical'],
  ['PATCH', '/api/admin/team/members/:id', { body: { role: 'OWNER' } }, 'critical'],
  ['DELETE', '/api/admin/clients/:id', {}, 'critical'],
  ['DELETE', '/api/projects/:id', {}, 'critical'],
  ['DELETE', '/api/admin/clients/:id/users/:userId', {}, 'critical'],
  ['POST', '/api/x/rotate', {}, 'critical'],
  ['POST', '/api/x/y', { routeConfig: { mcp: 'critical' } }, 'critical'],
  // ── blocked
  ['POST', '/api/auth/login', {}, 'blocked'],
  ['GET', '/api/auth/google/status', {}, 'blocked'],
  ['POST', '/api/mcp', {}, 'blocked'],
  ['GET', '/api/admin/mcp/status', {}, 'blocked'],
  ['POST', '/api/admin/mcp/grants/revoke-all', {}, 'blocked'],
  ['POST', '/api/admin/mcp/approvals/:id/approve', {}, 'blocked'],
  ['GET', '/api/public/issues/action', {}, 'blocked'],
  ['POST', '/api/webhooks/wp-pipeline-event', {}, 'blocked'],
  ['POST', '/api/tool/login', {}, 'blocked'],
  ['GET', '/api/omni-search/projects', {}, 'blocked'],
  ['GET', '/api/realtime/:projectId', {}, 'blocked'],
  ['POST', '/api/engine/google/token', {}, 'blocked'],
  ['GET', '/api/engine-review/outbox', {}, 'blocked'],
  ['POST', '/api/tasks/:id/engine-review/confirm', {}, 'blocked'],
  ['POST', '/api/admin/impersonate', { body: { userId: 'x' } }, 'blocked'],
  ['POST', '/api/admin/change-password', {}, 'blocked'],
  ['GET', '/api/admin/integrations/google/connect', {}, 'blocked'],
  ['POST', '/api/admin/api-tokens', { body: { userId: 'u', name: 'n' } }, 'blocked'],
  ['POST', '/api/projects/:id/cms/pairing-code', {}, 'blocked'],
  ['POST', '/api/projects/:id/cms/rotate-keys', {}, 'blocked'],
  ['POST', '/api/pm/projects/:projectId/integrations/ghl-forms/token', {}, 'blocked'],
  ['POST', '/api/pm/projects/:projectId/integrations/ghl-forms/rotate', {}, 'blocked'],
  ['POST', '/api/pm/projects/:projectId/integrations/ghl-forms/header-secret', {}, 'blocked'],
  ['POST', '/api/admin/clients/:id/reset-password', {}, 'blocked'],
  ['POST', '/api/tasks/:id/wp-login', {}, 'blocked'],
  ['POST', '/api/pm/issues/:id/wp-login', {}, 'blocked'],
  ['POST', '/api/pm/pipeline/:projectId/:wpPipelineId/preview-link', {}, 'blocked'],
  ['POST', '/api/pm/pipeline/:projectId/:wpPipelineId/renew-preview', {}, 'blocked'],
  ['POST', '/api/pm/pipeline/:projectId/:wpPipelineId/regenerate-preview-links', {}, 'blocked'],
  ['GET', '/api/pm/reports/:id/pdf', {}, 'blocked'],
  ['GET', '/api/client/reports/:month', {}, 'blocked'],
  ['PATCH', '/api/projects/:id', { body: { wpApiKey: 'k' } }, 'blocked'],
  ['PATCH', '/api/admin/clients/:id', { body: { nested: { password: 'p' } } }, 'blocked'],
  ['GET', '/api/tasks', { query: { apiKey: 'k' } }, 'blocked'],
  ['PATCH', '/api/admin/notifications/smtp', { body: { smtpPassword: 'p' } }, 'blocked'],
  ['POST', '/api/admin/change-own', { body: { currentPassword: 'a', newPassword: 'b' } }, 'blocked'],
  ['PATCH', '/api/admin/security-settings', { body: { webhookSecret: 's' } }, 'blocked'],
  ['POST', '/api/x/y', { body: { accessToken: 't' } }, 'blocked'],
  ['POST', '/api/x/y', { routeConfig: { mcp: 'blocked' } }, 'blocked'],
  // ── blocked: percent-encoded paths (review H1)
  ['POST', '/api/admin/%69mpersonate', {}, 'blocked'],
  ['POST', '/api/%61uth/login', {}, 'blocked'],
  ['POST', '/api/projects/x/cms/rotat%65-keys', {}, 'blocked'],
  ['GET', '/api/admin/%6dcp/grants', {}, 'blocked'],
  ['GET', '/health', {}, 'blocked'],
  ['GET', '/uploads/x.png', {}, 'blocked'],
];

describe('classifyRequest', () => {
  it.each(TABLE)('%s %s → %s', (method, pattern, extra, level) => {
    expect(c(method, pattern, extra).level).toBe(level);
  });

  it('has the documented size', () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(150);
  });

  it('blocked wins over dangerous, and the concrete path is checked too', () => {
    expect(c('DELETE', '/api/auth/session').level).toBe('blocked');
    expect(classifyRequest({ method: 'GET', routePattern: '/api/tasks', path: '/api/mcp/oauth/token' }).level).toBe('blocked');
    expect(classifyRequest({ method: 'POST', routePattern: '/api/tasks', path: '/api/admin/%69mpersonate' }).level).toBe('blocked');
  });

  it('accumulates reasons and reports the scope', () => {
    const r = c('DELETE', '/api/admin/clients/:id/users/:userId');
    expect(r.level).toBe('critical');
    expect(r.reasons).toEqual(expect.arrayContaining(['delete', 'people']));
    expect(r.scopeRequired).toBe('os:write');
    expect(c('GET', '/api/tasks').scopeRequired).toBe('os:read');
    expect(c('POST', '/api/tasks', { body: { title: 'x' } }).scopeRequired).toBe('os:write');
    expect(c('PATCH', '/api/tasks/:id/status', { body: { status: 'COMPLETED' } }).reasons).toContain('completes or cancels a task');
    expect(c('POST', '/api/pm/pipeline/sync').reasons).toContain('costly');
    expect(c('PATCH', '/api/projects/:id', { body: { wpUrl: 'https://x' } }).reasons).toContain('changes wpUrl');
  });

  it('the explicit critical list and the blocked routes are what the review asked for', () => {
    expect(EXPLICIT_CRITICAL.map(([, , why]) => why)).toEqual(expect.arrayContaining(['site publish', 'sends email to clients', 'people', 'cms migration', 'deletes a client / project', 'deletes a user', 'lead erase', 'visitor erase']));
    for (const k of ['POST /api/tasks/:id/wp-login', 'POST /api/pm/issues/:id/wp-login', 'POST /api/pm/pipeline/:projectId/:wpPipelineId/preview-link']) expect(BLOCKED_ROUTES.has(k)).toBe(true);
  });

  it('is pure: same input, same output, no mutation', () => {
    const body = { status: 'COMPLETED' };
    const a = c('PATCH', '/api/tasks/:id/status', { body });
    const b = c('PATCH', '/api/tasks/:id/status', { body });
    expect(a).toEqual(b);
    expect(body).toEqual({ status: 'COMPLETED' });
  });
});
