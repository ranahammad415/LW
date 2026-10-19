/**
 * Security hotfix: the PM preview link (token-only, can approve the PM stage) never reaches a client audience:
 * not in /api/client/* responses, not in any response to a CLIENT user, not as a notification link for client users.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const db = vi.hoisted(() => ({ calls: [], overrides: {} }));
vi.mock('../../src/lib/prisma.js', () => {
  const model = (name) =>
    new Proxy({}, {
      get(_, method) {
        const key = `${name}.${String(method)}`;
        return async (args) => {
          db.calls.push({ key, args });
          if (db.overrides[key]) return db.overrides[key](args);
          if (method === 'findMany') return [];
          if (method === 'count') return 0;
          if (method === 'updateMany') return { count: 1 };
          if (method === 'create' || method === 'update' || method === 'upsert') return { id: 'r1', ...(args?.data || args?.create || {}) };
          return null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});
const notified = vi.hoisted(() => []);
vi.mock('../../src/lib/notificationService.js', () => ({ notify: vi.fn(async (n) => notified.push(n)), notifyTest: vi.fn(async () => []) }));
vi.mock('../../src/lib/realtimeBus.js', () => ({ publish: vi.fn() }));
vi.mock('../../src/lib/contentMapSync.js', () => ({ mirrorPipelineToMaps: vi.fn(async () => {}), reconcileProjectMapsSafe: vi.fn() }));
vi.mock('../../src/lib/ai.js', () => ({ isAiConfigured: () => false, generateChat: vi.fn() }));

import { redactResponseSecrets, isClientAudience, CLIENT_DROP_KEYS } from '../../src/lib/redactSecrets.js';
import { applyReviewEvent } from '../../src/lib/reviewEvents.js';
import { normalizePipelineWebhook } from '../../src/lib/siteAdapters/wordpress.js';

const PM_LINK = 'https://client.example/?lwa_preview=PMTOKEN123';
const CLIENT_LINK = 'https://client.example/?lwa_client=CLIENTTOKEN';

beforeEach(() => {
  db.calls = [];
  db.overrides = {};
  notified.length = 0;
});

describe('responses to client audiences', () => {
  it('drops pmPreviewUrl at any depth for clients; staff responses keep it', () => {
    const payload = [{ id: 'r1', pmPreviewUrl: PM_LINK, clientPreviewUrl: CLIENT_LINK, nested: { pipeline: { pmPreviewUrl: PM_LINK } } }];
    const out = redactResponseSecrets(payload, 0, CLIENT_DROP_KEYS);
    expect(JSON.stringify(out)).not.toContain('PMTOKEN123');
    expect(out[0].clientPreviewUrl).toBe(CLIENT_LINK);
    expect(redactResponseSecrets(payload)[0].pmPreviewUrl).toBe(PM_LINK);
    expect(isClientAudience({ user: { role: 'CLIENT' }, url: '/api/pm/x' })).toBe(true);
    expect(isClientAudience({ user: { role: 'OWNER' }, url: '/api/client/projects/p1/pipeline' })).toBe(true);
    expect(isClientAudience({ user: { role: 'PM' }, url: '/api/pm/pipeline' })).toBe(false);
  });

  it('the preSerialization hook applies it to every route', async () => {
    const app = Fastify();
    app.setSerializerCompiler(() => (data) => JSON.stringify(data));
    app.addHook('onRequest', async (request) => {
      request.user = { role: request.headers['x-role'] };
    });
    app.addHook('preSerialization', async (request, _r, payload) => redactResponseSecrets(payload, 0, isClientAudience(request) ? CLIENT_DROP_KEYS : null));
    const body = { pmPreviewUrl: PM_LINK, clientPreviewUrl: CLIENT_LINK };
    app.get('/api/client/projects/p1/pipeline', async () => [body]);
    app.get('/api/pm/pipeline', async () => [body]);
    const asOwnerOnClientRoute = await app.inject({ method: 'GET', url: '/api/client/projects/p1/pipeline', headers: { 'x-role': 'OWNER' } });
    expect(asOwnerOnClientRoute.body).not.toContain('PMTOKEN123');
    const asClient = await app.inject({ method: 'GET', url: '/api/pm/pipeline', headers: { 'x-role': 'CLIENT' } });
    expect(asClient.body).not.toContain('PMTOKEN123');
    const asPm = await app.inject({ method: 'GET', url: '/api/pm/pipeline', headers: { 'x-role': 'PM' } });
    expect(asPm.json()[0].pmPreviewUrl).toBe(PM_LINK);
    await app.close();
  });
});

describe('notifications that reach client users', () => {
  const project = { id: 'p1', leadPmId: 'pm1', name: 'Oasis' };

  it('content_published never links the PM preview (falls back to the portal, not the PM link)', async () => {
    db.overrides['wpContentReview.findUnique'] = async () => ({ id: 'r1', isPublished: false, status: 'client_approved', assignedWorkerId: null });
    db.overrides['project.findUnique'] = async () => ({ clientId: 'c1' });
    db.overrides['clientUser.findMany'] = async () => [{ userId: 'client-user' }];
    db.overrides['user.findMany'] = async () => [{ id: 'owner-1' }];
    const n = normalizePipelineWebhook({ pipelineId: 7, eventType: 'pipeline_published', postId: 118, status: 'published', postTitle: 'Hot tub', pmPreviewUrl: PM_LINK });
    await applyReviewEvent({ project, event: n });
    await new Promise((r) => setTimeout(r, 0));
    const published = notified.find((x) => x.slug === 'content_published');
    expect(published.recipientIds).toContain('client-user');
    expect(published.actionUrl).not.toContain('PMTOKEN123');
  });

  it('a resend while the client must review links the client preview, never the PM link', async () => {
    db.overrides['wpContentReview.findUnique'] = async () => ({ id: 'r1', isPublished: false, status: 'pending_client_review', assignedWorkerId: null });
    db.overrides['project.findUnique'] = async () => ({ clientId: 'c1' });
    db.overrides['clientUser.findMany'] = async () => [{ userId: 'client-user' }];
    const n = normalizePipelineWebhook({ pipelineId: 7, eventType: 'pipeline_resend_notification', postId: 118, status: 'pending_client_review', postTitle: 'Hot tub', pmPreviewUrl: PM_LINK });
    await applyReviewEvent({ project, event: n });
    await new Promise((r) => setTimeout(r, 0));
    for (const x of notified) expect(String(x.actionUrl)).not.toContain('PMTOKEN123');
    expect(notified.length).toBeGreaterThan(0);
  });
});
