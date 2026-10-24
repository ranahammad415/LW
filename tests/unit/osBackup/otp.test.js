import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

vi.mock('../../../src/lib/osBackup/store.js', async () => (await import('./memStore.js')).makeMemStore());

const store = await import('../../../src/lib/osBackup/store.js');
const otp = await import('../../../src/lib/osBackup/otp.js');

const KEY = crypto.randomBytes(32);
const T0 = new Date('2026-11-15T10:00:00Z');
const at = (ms) => new Date(T0.getTime() + ms);
const base = { master: KEY, userId: 'owner-1', email: 'o@x.io', action: 'RESTORE', backupId: 'b1' };

beforeEach(() => {
  store.__t.challenges.clear();
});

async function make(over = {}) {
  return otp.createChallenge(null, { ...base, now: T0, ...over });
}
const verify = (ch, code, over = {}) => otp.verifyChallenge(null, { master: KEY, id: ch.id, userId: base.userId, action: 'RESTORE', backupId: 'b1', code, now: at(1000), ...over });

describe('osBackup OTP', () => {
  it('stores only an HMAC of the code, bound to challenge, user, action and backup', async () => {
    const { challenge, code } = await make();
    expect(code).toMatch(/^\d{6}$/);
    expect(challenge.codeHash).toHaveLength(64);
    expect(challenge.codeHash).not.toContain(code);
    expect(challenge.codeHash).toBe(otp.hashCode(otp.otpKey(KEY), { id: challenge.id, userId: 'owner-1', action: 'RESTORE', backupId: 'b1', code }));
  });

  it('a correct code verifies once (single use)', async () => {
    const { challenge, code } = await make();
    await expect(verify(challenge, code)).resolves.toMatchObject({ id: challenge.id });
    await expect(verify(challenge, code)).rejects.toMatchObject({ message: otp.GENERIC });
  });

  it('expires after 10 minutes', async () => {
    const { challenge, code } = await make();
    await expect(verify(challenge, code, { now: at(otp.OTP_TTL_MS + 1) })).rejects.toMatchObject({ message: otp.GENERIC });
  });

  it('5 attempts, then even the right code fails', async () => {
    const { challenge, code } = await make();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) await expect(verify(challenge, wrong)).rejects.toMatchObject({ code: 'OTP_INVALID' });
    expect(otp.attemptsLeft(await store.getChallenge(null, challenge.id))).toBe(0);
    await expect(verify(challenge, code)).rejects.toMatchObject({ message: otp.GENERIC });
  });

  it('binding: wrong user, action or backup fails', async () => {
    const { challenge, code } = await make();
    await expect(verify(challenge, code, { userId: 'owner-2' })).rejects.toThrow(otp.GENERIC);
    await expect(verify(challenge, code, { action: 'DOWNLOAD' })).rejects.toThrow(otp.GENERIC);
    await expect(verify(challenge, code, { backupId: 'b2' })).rejects.toThrow(otp.GENERIC);
    await expect(verify(challenge, code)).resolves.toBeTruthy();
  });

  it('a new challenge invalidates the open one of the same user + action', async () => {
    const a = await make();
    const b = await make({ now: at(1000) });
    await expect(verify(a.challenge, a.code)).rejects.toThrow(otp.GENERIC);
    await expect(verify(b.challenge, b.code, { now: at(2000) })).resolves.toBeTruthy();
  });

  it('at most 5 challenges per user per hour', async () => {
    for (let i = 0; i < 5; i += 1) await make({ now: at(i * 1000) });
    await expect(make({ now: at(6000) })).rejects.toMatchObject({ code: 'OTP_RATE', status: 429 });
    await expect(make({ now: at(3_600_000 + 10_000) })).resolves.toBeTruthy();
  });

  it('resend: ≥ 60 s apart, ≤ 3 sends, the old code stops working', async () => {
    const { challenge, code } = await make();
    await expect(otp.resendChallenge(null, { master: KEY, id: challenge.id, userId: 'owner-1', now: at(30_000) })).rejects.toMatchObject({ code: 'OTP_RESEND' });
    const r1 = await otp.resendChallenge(null, { master: KEY, id: challenge.id, userId: 'owner-1', now: at(61_000) });
    await otp.resendChallenge(null, { master: KEY, id: challenge.id, userId: 'owner-1', now: at(122_000) });
    await expect(otp.resendChallenge(null, { master: KEY, id: challenge.id, userId: 'owner-1', now: at(200_000) })).rejects.toMatchObject({ code: 'OTP_RESEND' });
    await expect(otp.resendChallenge(null, { master: KEY, id: challenge.id, userId: 'owner-2', now: at(300_000) })).rejects.toThrow(otp.GENERIC);
    if (r1.code !== code) await expect(verify(challenge, code, { now: at(123_000) })).rejects.toThrow(otp.GENERIC);
  });

  it('malformed codes fail without counting', async () => {
    const { challenge } = await make();
    await expect(verify(challenge, '12ab56')).rejects.toThrow(otp.GENERIC);
    expect((await store.getChallenge(null, challenge.id)).attempts).toBe(0);
  });

  it('watch token: own key, bound to the job, rejected by the session secret', async () => {
    const t = otp.mintWatchToken(KEY, { userId: 'owner-1', jobId: 'job-1' });
    expect(otp.verifyWatchToken(KEY, t, 'job-1')).toMatchObject({ sub: 'owner-1', typ: 'lwos_watch' });
    expect(otp.verifyWatchToken(KEY, t, 'job-2')).toBeNull();
    expect(otp.verifyWatchToken(crypto.randomBytes(32), t, 'job-1')).toBeNull();
    const jwt = (await import('jsonwebtoken')).default;
    expect(() => jwt.verify(t, process.env.JWT_ACCESS_SECRET || 'x'.repeat(40))).toThrow();
  });

  it('download tickets: random 32 bytes, stored as sha256', () => {
    const t = otp.newTicket();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(otp.ticketHash(t)).toHaveLength(64);
  });
});
