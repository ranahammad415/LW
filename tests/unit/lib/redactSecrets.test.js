/** e2e O21: no response carries the WordPress plugin key or CMS credential secrets (serializer is plain JSON). */
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { redactResponseSecrets, REDACTED } from '../../../src/lib/redactSecrets.js';

describe('redactResponseSecrets', () => {
  it('redacts wpApiKey at any depth (e.g. GET /api/tasks → task.project) and drops credential secrets', () => {
    const at = new Date('2026-10-17T00:00:00Z');
    const input = [
      { id: 't1', createdAt: at, project: { id: 'p1', name: 'Oasis', wpUrl: 'https://x', wpApiKey: 'secret-key', client: { id: 'c1' } } },
      { id: 't2', project: { id: 'p2', wpApiKey: null } },
    ];
    const out = redactResponseSecrets(input);
    expect(out[0].project.wpApiKey).toBe(REDACTED);
    expect(out[0].project.name).toBe('Oasis');
    expect(out[0].createdAt).toBe(at);
    expect(out[1]).toBe(input[1]); // unchanged branches are not copied
    expect(input[0].project.wpApiKey).toBe('secret-key'); // input never mutated
    const cred = redactResponseSecrets({ keyId: 2, inboundKeyEnc: 'e1', outboundKeyEnc: 'e2', outboundKeyPendingEnc: 'e3', verifier: 'v', signingKeyEnc: 's' });
    expect(cred).toEqual({ keyId: 2 });
    expect(JSON.stringify(redactResponseSecrets({ a: { b: { c: { project: { wpApiKey: 'k' } } } } }))).not.toContain('"k"');
  });

  it('applies to every route through the preSerialization hook (also routes with a response schema)', async () => {
    const app = Fastify();
    app.setSerializerCompiler(() => (data) => JSON.stringify(data));
    app.addHook('preSerialization', async (_q, _r, payload) => redactResponseSecrets(payload));
    app.get('/tasks', { schema: { response: { 200: { type: 'array', items: { type: 'object', properties: { project: { type: 'object' } } } } } } }, async () => [
      { id: 't1', project: { id: 'p1', wpApiKey: '0f1e2d3c-4b5a-4968-8776-655443322110' } },
    ]);
    app.get('/plain', async () => ({ project: { wpApiKey: 'abc' } }));
    const a = await app.inject({ method: 'GET', url: '/tasks' });
    expect(a.body).not.toContain('0f1e2d3c');
    expect(a.json()[0].project.wpApiKey).toBe(REDACTED);
    const b = await app.inject({ method: 'GET', url: '/plain' });
    expect(b.json().project.wpApiKey).toBe(REDACTED);
    await app.close();
  });
});
