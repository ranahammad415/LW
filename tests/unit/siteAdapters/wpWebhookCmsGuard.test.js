/** Review C2: WP webhooks only resolve WordPress projects (a stray WP plugin cannot write into an EmDash project). */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';

const calls = vi.hoisted(() => []);
vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: new Proxy({}, {
    get: (_, model) => new Proxy({}, {
      get: (__, method) => async (args) => {
        calls.push({ key: `${String(model)}.${String(method)}`, args });
        return null;
      },
    }),
  }),
}));
vi.mock('../../../src/lib/notificationService.js', () => ({ notify: vi.fn(), notifyTest: vi.fn() }));
vi.mock('../../../src/lib/contentMapSync.js', () => ({ reconcileProjectMapsSafe: vi.fn(), mirrorPipelineToMaps: vi.fn(async () => {}) }));

import { wpWebhookRoutes } from '../../../src/routes/webhooks.js';

let app;
beforeAll(async () => {
  app = Fastify();
  await app.register(wpWebhookRoutes, { prefix: '/api/webhooks' });
  await app.ready();
});
afterAll(async () => app.close());

describe('WP webhook project lookup', () => {
  it.each(['wp-content-change', 'wp-pipeline-event', 'wp-lead-event'])('%s filters cmsType WORDPRESS', async (route) => {
    calls.length = 0;
    const r = await app.inject({ method: 'POST', url: `/api/webhooks/${route}`, payload: { apiKey: 'k-1', eventType: 'phone_click', pipelineId: 1, wpPostId: 1 } });
    expect(r.statusCode).toBe(401);
    const lookup = calls.find((c) => c.key === 'project.findFirst');
    expect(lookup.args.where).toEqual({ wpApiKey: 'k-1', cmsType: 'WORDPRESS' });
  });
});
