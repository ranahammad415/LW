/**
 * OS-18: agency-wide Google disconnect (revocation + credential wipe + explicit confirmation + stale consent guard).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ calls: [], overrides: {} }));
vi.mock('../../../src/lib/prisma.js', () => {
  const model = (name) =>
    new Proxy({}, {
      get(_, method) {
        const key = `${name}.${String(method)}`;
        return async (args) => {
          db.calls.push({ key, args });
          if (db.overrides[key]) return db.overrides[key](args);
          if (method === 'findMany') return [];
          if (method === 'updateMany') return { count: 0 };
          return null;
        };
      },
    });
  const root = new Proxy({}, { get: (_, n) => (n === '$transaction' ? async (fn) => fn(root) : model(String(n))) });
  return { prisma: root };
});
vi.mock('../../../src/lib/analytics/tokenCrypto.js', () => ({
  decryptSecret: (enc) => {
    if (enc === 'broken') throw new Error('bad');
    return `plain-${enc}`;
  },
}));
const cache = vi.hoisted(() => ({ cleared: 0 }));
vi.mock('../../../src/lib/analytics/gscAdapter.js', () => ({ clearGscClientCache: () => { cache.cleared += 1; } }));

const { revokeGoogleRefreshToken, disconnectAgencyGoogle, isConsentStale, GOOGLE_REVOKE_URL, DISCONNECT_SCOPE } = await import('../../../src/lib/analytics/googleDisconnect.js');

const OWNER = { id: 'u-owner', role: 'OWNER' };
const confirm = { actor: OWNER, scope: DISCONNECT_SCOPE, confirmAgencyWide: true };

beforeEach(() => {
  db.calls = [];
  db.overrides = {};
  cache.cleared = 0;
});

describe('revokeGoogleRefreshToken', () => {
  it('posts the token to the fixed revoke endpoint and only treats HTTP 200 as confirmed', async () => {
    let sent;
    const ok = await revokeGoogleRefreshToken('rt-1', { fetchImpl: async (url, init) => { sent = { url, init }; return { status: 200 }; } });
    expect(ok.confirmed).toBe(true);
    expect(sent.url).toBe(GOOGLE_REVOKE_URL);
    expect(sent.init.redirect).toBe('error');
    expect(new URLSearchParams(sent.init.body).get('token')).toBe('rt-1');
    expect((await revokeGoogleRefreshToken('rt-1', { fetchImpl: async () => ({ status: 400 }) })).confirmed).toBe(false);
    expect((await revokeGoogleRefreshToken('rt-1', { fetchImpl: async () => { throw new Error('timeout'); } })).confirmed).toBe(false);
    expect((await revokeGoogleRefreshToken('', { fetchImpl: async () => ({ status: 200 }) })).confirmed).toBe(false);
  });
});

describe('disconnectAgencyGoogle', () => {
  it('requires an Owner and explicit agency-wide confirmation', async () => {
    await expect(disconnectAgencyGoogle({ actor: OWNER })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED', status: 403 });
    await expect(disconnectAgencyGoogle({ ...confirm, actor: { id: 'pm', role: 'PM' } })).rejects.toMatchObject({ status: 403 });
    expect(db.calls).toHaveLength(0);
  });

  it('fences, revokes and wipes every stored credential (incl. old status-only DISCONNECTED rows)', async () => {
    db.overrides['agencyGoogleConnection.findMany'] = async () => [
      { id: 'a', refreshTokenEnc: 'enc-a', status: 'ACTIVE' },
      { id: 'b', refreshTokenEnc: 'enc-b', status: 'DISCONNECTED' },
    ];
    const revoked = [];
    const receipt = await disconnectAgencyGoogle(confirm, { fetchImpl: async (_u, init) => { revoked.push(new URLSearchParams(init.body).get('token')); return { status: 200 }; } });
    expect(revoked).toEqual(['plain-enc-a', 'plain-enc-b']);
    const fence = db.calls.find((c) => c.key === 'agencyGoogleConnection.updateMany').args;
    expect(fence.data.status).toBe('DISCONNECTING');
    const wipes = db.calls.filter((c) => c.key === 'agencyGoogleConnection.update').map((c) => c.args.data);
    expect(wipes).toHaveLength(2);
    for (const w of wipes) expect(w).toMatchObject({ status: 'DISCONNECTED', refreshTokenEnc: '', googleEmail: '', scopes: '', connectedById: null });
    expect(receipt).toMatchObject({ remoteRevocationConfirmed: true, revokedCredentials: 2, scope: DISCONNECT_SCOPE, localCredentialsRemoved: true });
    expect(cache.cleared).toBe(1);
    expect(JSON.stringify(receipt)).not.toContain('plain-');
  });

  it('wipes locally but reports REVOKE_UNKNOWN when Google does not confirm (or decryption fails)', async () => {
    db.overrides['agencyGoogleConnection.findMany'] = async () => [{ id: 'a', refreshTokenEnc: 'broken', status: 'ACTIVE' }];
    const receipt = await disconnectAgencyGoogle(confirm, { fetchImpl: async () => ({ status: 200 }) });
    expect(receipt.remoteRevocationConfirmed).toBe(false);
    expect(receipt.manualGoogleAccountRevocationRequired).toBe(true);
    const wipe = db.calls.find((c) => c.key === 'agencyGoogleConnection.update').args.data;
    expect(wipe).toMatchObject({ status: 'REVOKE_UNKNOWN', refreshTokenEnc: '', lastError: 'GOOGLE_REVOCATION_UNCONFIRMED' });
  });
});

describe('stale consent guard', () => {
  it('a consent issued before the latest disconnect is stale; a later one is not', async () => {
    db.overrides['agencyGoogleConnection.findFirst'] = async () => ({ updatedAt: new Date('2026-10-19T10:00:00Z') });
    expect(await isConsentStale(Date.parse('2026-10-19T09:59:00Z') / 1000)).toBe(true);
    expect(await isConsentStale(Date.parse('2026-10-19T10:01:00Z') / 1000)).toBe(false);
    db.overrides['agencyGoogleConnection.findFirst'] = async () => null;
    expect(await isConsentStale(1)).toBe(false);
    expect(await isConsentStale(undefined)).toBe(true);
  });
});
