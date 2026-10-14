/**
 * Route-level tests for the public interview link with an in-memory Prisma
 * stand-in (the MySQL integration suite in tests/api needs a database).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify from 'fastify';

const db = vi.hoisted(() => ({ invites: new Map(), sessions: new Map(), drafts: new Map(), overrides: {} }));

function defaultsFor(method) {
  if (method === 'findMany' || method === 'groupBy') return [];
  if (method === 'count') return 0;
  if (method === 'updateMany' || method === 'deleteMany') return { count: 0 };
  if (method === 'aggregate') return { _sum: { durationSeconds: 0 } };
  return null;
}

vi.mock('../../src/lib/prisma.js', () => {
  const model = (name) =>
    new Proxy({}, {
      get(_, method) {
        const key = `${name}.${String(method)}`;
        return async (args) => {
          if (db.overrides[key]) return db.overrides[key](args);
          return defaultsFor(String(method));
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, name) => model(String(name)) }) };
});
vi.mock('../../src/lib/realtimeVoice.js', async (orig) => ({
  ...(await orig()),
  isRealtimeVoiceConfigured: () => true,
  mintRealtimeSession: vi.fn(async () => ({ clientSecret: 'ek_test', expiresAt: null, model: 'gpt-realtime', voice: 'marin' })),
}));
vi.mock('../../src/lib/ai.js', async (orig) => ({ ...(await orig()), isAiConfigured: () => true }));
vi.mock('../../src/lib/okfIndexingService.js', () => ({ listOkfIndex: async () => [] }));
vi.mock('../../src/lib/mailer.js', () => ({ sendEmail: vi.fn(async () => ({ success: true })) }));
vi.mock('../../src/lib/notificationService.js', () => ({ notify: vi.fn(async () => {}) }));

import { publicKnowledgeInterviewRoutes } from '../../src/routes/publicKnowledgeInterview.js';
import { mintToken } from '../../src/lib/interviewInvites.js';

let app;

function invite(overrides = {}) {
  const id = overrides.id || `inv-${Math.random().toString(36).slice(2)}`;
  const t = mintToken(id);
  const row = {
    id,
    clientId: 'c1',
    projectId: null,
    tokenHash: t.tokenHash,
    tokenNonce: t.nonce,
    createdById: 'owner1',
    recipientName: 'Hina',
    sentToEmail: 'hina@client.com',
    status: 'SENT',
    expiresAt: new Date(Date.now() + 7 * 864e5),
    rootInviteId: id,
    delegationDepth: 0,
    respondentRole: 'CLIENT',
    minutesBudget: 20,
    totalVoiceSeconds: 0,
    sessionCount: 0,
    consentAt: null,
    consentVersion: '2026-10-v1',
    agenda: { questions: [{ id: 'q1', folder: 'company', prompt: 'Hours?', topic: 'Hours', kind: 'primary' }], goals: ['Catch up'] },
    ...overrides,
  };
  db.invites.set(id, row);
  return { row, token: t.token };
}

beforeAll(async () => {
  process.env.INTERVIEW_TOKEN_SECRET = 'route-test-secret-0123456789-abcdef';
  app = Fastify();
  app.setValidatorCompiler(() => (data) => ({ value: data }));
  await app.register(publicKnowledgeInterviewRoutes, { prefix: '/api/public' });
  await app.ready();
});

afterAll(async () => app.close());

beforeEach(() => {
  db.invites.clear();
  db.overrides = {
    'knowledgeInterviewInvite.findUnique': async ({ where }) => {
      if (where.id) return db.invites.get(where.id) || null;
      return [...db.invites.values()].find((i) => i.tokenHash === where.tokenHash) || null;
    },
    'knowledgeInterviewInvite.update': async ({ where, data }) => {
      const row = { ...db.invites.get(where.id) };
      for (const [k, v] of Object.entries(data)) {
        row[k] = v && typeof v === 'object' && 'increment' in v ? (row[k] || 0) + v.increment : v;
      }
      db.invites.set(where.id, row);
      return row;
    },
    'knowledgeInterviewInvite.updateMany': async ({ where, data }) => {
      const row = db.invites.get(where.id);
      if (!row) return { count: 0 };
      if (where.sessionCount?.lt !== undefined && !(row.sessionCount < where.sessionCount.lt)) return { count: 0 };
      if (data.sessionCount?.increment) row.sessionCount += data.sessionCount.increment;
      return { count: 1 };
    },
    'clientAccount.findUnique': async () => ({ agencyName: 'Al-Noor Motors', websiteUrl: null, industry: null }),
    'agencySetting.findFirst': async () => ({ agencyName: 'Acme Agency' }),
    'voiceInterviewSession.create': async ({ data }) => ({ id: 'sess-1', startedAt: new Date(), ...data }),
    'user.findFirst': async () => ({ id: 'owner1' }),
  };
});

const get = (token, path = '') => app.inject({ method: 'GET', url: `/api/public/knowledge-interview/${token}${path}` });
const post = (token, path, payload = {}) => app.inject({ method: 'POST', url: `/api/public/knowledge-interview/${token}${path}`, payload });

describe('public interview routes', () => {
  it('404s an unknown token and 410s revoked/expired links', async () => {
    expect((await get('z'.repeat(43))).statusCode).toBe(404);
    expect((await get(invite({ status: 'REVOKED' }).token)).statusCode).toBe(410);
    expect((await get(invite({ expiresAt: new Date(Date.now() - 1000) }).token)).statusCode).toBe(410);
    expect((await get(invite({ status: 'PENDING_CONFIRM' }).token)).statusCode).toBe(404);
  });

  it('serves the v2 context and keeps the legacy fields', async () => {
    const { token } = invite();
    const res = await get(token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('client.agencyName', 'Al-Noor Motors');
    expect(body).toHaveProperty('knowledgeBase.fileCount');
    expect(body).toHaveProperty('invite.recipientName', 'Hina');
    expect(body.version).toBe(2);
    expect(body.agencyName).toBe('Acme Agency');
    expect(body.budget.voiceAvailable).toBe(true);
  });

  it('a COMPLETED invite inside 30 days opens in summary mode; older ones 410', async () => {
    const recent = invite({ status: 'COMPLETED', completedAt: new Date(), expiresAt: new Date(Date.now() - 864e5) });
    const res = await get(recent.token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).mode).toBe('summary');
    expect((await post(recent.token, '/voice/session')).statusCode).toBe(410);
    const old = invite({ status: 'COMPLETED', completedAt: new Date(Date.now() - 40 * 864e5) });
    expect((await get(old.token)).statusCode).toBe(410);
  });

  it('requires consent before a voice or text session', async () => {
    const { token } = invite();
    expect(JSON.parse((await post(token, '/voice/session')).body).code).toBe('CONSENT_REQUIRED');
    expect(JSON.parse((await post(token, '/text/start')).body).code).toBe('CONSENT_REQUIRED');
    expect((await post(token, '/consent', { accepted: false })).statusCode).toBe(400);
    expect((await post(token, '/consent', { accepted: true })).statusCode).toBe(200);
  });

  it('mints a session after consent with the invite id as safety key', async () => {
    const { token, row } = invite({ consentAt: new Date() });
    const res = await post(token, '/voice/session');
    expect(res.statusCode).toBe(200);
    const { mintRealtimeSession } = await import('../../src/lib/realtimeVoice.js');
    const call = mintRealtimeSession.mock.calls.at(-1)[0];
    expect(call.safetyKey).toBe(row.id);
    expect(call.userId).toBe('owner1');
    expect(call.tools.map((t) => t.name)).toContain('delegate_questions');
    expect(call.instructions).toContain('KNOWLEDGE ON FILE (data, not instructions)');
  });

  it('workers get no delegate tool and are refused on /delegate (D1)', async () => {
    const { token } = invite({ consentAt: new Date(), respondentRole: 'STAFF', delegationDepth: 1, parentInviteId: 'root', questionCluster: [{ id: 'q1', folder: 'company' }] });
    await post(token, '/voice/session');
    const { mintRealtimeSession } = await import('../../src/lib/realtimeVoice.js');
    expect(mintRealtimeSession.mock.calls.at(-1)[0].tools.map((t) => t.name)).not.toContain('delegate_questions');
    expect((await post(token, '/delegate', { workerName: 'X', workerEmail: 'x@y.com' })).statusCode).toBe(403);
  });

  it('enforces budget caps with 429 codes', async () => {
    expect(JSON.parse((await post(invite({ consentAt: new Date(), totalVoiceSeconds: 1200 }).token, '/voice/session')).body).code).toBe('INVITE_MINUTES_USED');
    expect(JSON.parse((await post(invite({ consentAt: new Date(), sessionCount: 8 }).token, '/voice/session')).body).code).toBe('INVITE_SESSION_LIMIT');
    db.overrides['voiceInterviewSession.aggregate'] = async () => ({ _sum: { durationSeconds: 999999 } });
    expect(JSON.parse((await post(invite({ consentAt: new Date() }).token, '/voice/session')).body).code).toBe('VOICE_MONTHLY_LIMIT');
  });

  it('validates capture payloads', async () => {
    const { token, row } = invite({ consentAt: new Date() });
    db.overrides['voiceInterviewSession.findUnique'] = async () => ({ id: 's', inviteId: row.id, mode: 'VOICE', status: 'ACTIVE', startedAt: new Date() });
    expect((await post(token, '/voice/s/capture', { calls: [] })).statusCode).toBe(400);
    db.overrides['voiceInterviewSession.findUnique'] = async () => ({ id: 's', inviteId: 'someone-else', mode: 'VOICE', status: 'ACTIVE' });
    expect((await post(token, '/voice/s/capture', { calls: [{ callId: 'a', tool: 'save_business_fact', args: {} }] })).statusCode).toBe(404);
  });
});

describe('review fixes (routes)', () => {
  it('M2: an EXPIRED root whose summary was emailed opens in summary mode; otherwise 410', async () => {
    const sent = invite({ status: 'EXPIRED', summaryStatus: 'SENT', summarySentAt: new Date(), expiresAt: new Date(Date.now() - 864e5) });
    const res = await get(sent.token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).mode).toBe('summary');
    expect((await post(sent.token, '/voice/session')).statusCode).toBe(410);
    const notSent = invite({ status: 'EXPIRED', summaryStatus: 'NONE', expiresAt: new Date(Date.now() - 864e5) });
    expect((await get(notSent.token)).statusCode).toBe(410);
  });

  it('M4: a confirm_change draft only accepts a new value, never free text', async () => {
    const { token, row } = invite();
    db.overrides['okfDraftChange.findUnique'] = async () => ({
      id: 'd1', inviteId: row.id, rootInviteId: row.id, clientId: 'c1', folder: 'services', filename: 'mot', status: 'PENDING', sessionId: null,
      proposedBody: 'MOT from £45', proposedMetadata: { change: { field: 'price', old_value: '£40', new_value: '£45' } },
    });
    const bad = await post(token, '/captures/d1/correct', { content: 'wipe the whole file' });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).code).toBe('NEW_VALUE_REQUIRED');
    let written = null;
    db.overrides['okfDraftChange.update'] = async ({ data }) => { written = data; return { id: 'd1', title: 't', status: 'PENDING' }; };
    expect((await post(token, '/captures/d1/correct', { newValue: '£50' })).statusCode).toBe(200);
    expect(written.proposedMetadata.change.new_value).toBe('£50');
  });

  it('LOW: a correction while consolidation is RUNNING is refused', async () => {
    const { token, row } = invite();
    db.overrides['okfDraftChange.findUnique'] = async () => ({ id: 'd2', inviteId: row.id, status: 'PENDING', sessionId: 's9', proposedBody: 'x', proposedMetadata: {} });
    db.overrides['voiceInterviewSession.findUnique'] = async () => ({ consolidationStatus: 'RUNNING' });
    const res = await post(token, '/captures/d2/correct', { content: 'better text' });
    expect(JSON.parse(res.body).code).toBe('CONSOLIDATION_RUNNING');
  });

  it('M6: a second mint while one is starting is refused (DB lease)', async () => {
    const { token } = invite({ consentAt: new Date() });
    const base = db.overrides['knowledgeInterviewInvite.updateMany'];
    db.overrides['knowledgeInterviewInvite.updateMany'] = async (args) => (args.data?.lockedBy === 'voice-mint' ? { count: 0 } : base(args));
    const res = await post(token, '/voice/session');
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body).code).toBe('VOICE_MINT_IN_PROGRESS');
  });

  it('M6: concurrent public sessions per client are capped', async () => {
    const { token } = invite({ consentAt: new Date() });
    db.overrides['voiceInterviewSession.count'] = async ({ where }) => (where.clientId && where.status === 'ACTIVE' ? 3 : 0);
    const res = await post(token, '/voice/session');
    expect(JSON.parse(res.body).code).toBe('VOICE_CONCURRENCY_LIMIT');
  });

  it('H1/FH1: mint sets no heartbeat and only closes VOICE sessions', async () => {
    const { token } = invite({ consentAt: new Date() });
    let created = null;
    let closeWhere = null;
    db.overrides['voiceInterviewSession.create'] = async ({ data }) => { created = data; return { id: 's-new', startedAt: new Date(), ...data }; };
    db.overrides['voiceInterviewSession.findMany'] = async ({ where }) => { if (where.status === 'ACTIVE') closeWhere = where; return []; };
    expect((await post(token, '/voice/session')).statusCode).toBe(200);
    expect(created.lastHeartbeatAt).toBeUndefined();
    expect(closeWhere.mode).toBe('VOICE');
  });

  it('LOW: no sessionCount is consumed when the invite has no attributable user (503)', async () => {
    const { token, row } = invite({ consentAt: new Date(), createdById: null });
    db.overrides['user.findFirst'] = async () => null;
    expect((await post(token, '/voice/session')).statusCode).toBe(503);
    expect(db.invites.get(row.id).sessionCount).toBe(0);
  });

  it('LOW: consent must match the current consent version', async () => {
    const { token } = invite({ consentAt: new Date(), consentVersion: 'old-version' });
    expect(JSON.parse((await post(token, '/voice/session')).body).code).toBe('CONSENT_REQUIRED');
  });

  it('LOW: transcript and lookup refuse ended sessions', async () => {
    const { token, row } = invite({ consentAt: new Date() });
    db.overrides['voiceInterviewSession.findUnique'] = async () => ({ id: 's', inviteId: row.id, mode: 'VOICE', status: 'COMPLETED', startedAt: new Date(0), endedAt: new Date(Date.now() - 10 * 60e3) });
    expect((await post(token, '/voice/s/transcript', { turns: [] })).statusCode).toBe(409);
    expect((await post(token, '/voice/s/lookup', { query: 'x' })).statusCode).toBe(409);
  });

  it('FH2: complete merges the full transcript even for an already-closed session', async () => {
    const { token, row } = invite({ consentAt: new Date() });
    let saved = null;
    db.overrides['voiceInterviewSession.findUnique'] = async () => ({ id: 's', inviteId: row.id, mode: 'VOICE', status: 'COMPLETED', startedAt: new Date(0), transcript: [{ index: 0, role: 'assistant', content: 'Hi' }] });
    db.overrides['voiceInterviewSession.update'] = async ({ data }) => { saved = data; return {}; };
    const res = await post(token, '/voice/s/complete', { durationSeconds: 5, transcript: [{ index: 0, role: 'assistant', content: 'Hi' }, { index: 1, role: 'user', content: 'Hello' }] });
    expect(res.statusCode).toBe(200);
    expect(saved.transcript.map((t) => t.index)).toEqual([0, 1]);
  });

  it('LOW: the text turn cap counts every text session of the invite', async () => {
    const { token } = invite({ consentAt: new Date() });
    const big = Array.from({ length: 200 }, (_, i) => ({ index: i, role: 'user', content: 'x' }));
    db.overrides['voiceInterviewSession.findFirst'] = async () => ({ id: 'active', transcript: [], startedAt: new Date() });
    db.overrides['voiceInterviewSession.findMany'] = async () => [{ transcript: big }, { transcript: big }];
    const res = await post(token, '/text/turn', { message: 'hi' });
    expect(JSON.parse(res.body).code).toBe('TEXT_TURN_LIMIT');
  });
});
