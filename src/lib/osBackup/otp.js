/**
 * Email OTP for RESTORE and DOWNLOAD (plan g.1).
 *   code      6 digits from crypto.randomInt, zero-padded
 *   codeHash  HMAC-SHA256(HKDF(master, 'lwos-otp'), challengeId:userId:action:backupId:code) → bound to user, action, backup
 *   rules     TTL 10 min, 5 attempts, single use, a new challenge invalidates the open ones of the same user + action,
 *             ≤ 3 sends per challenge ≥ 60 s apart, ≤ 5 challenges per user per hour
 * Verify: (1) attempts+1 only while open / bound / unexpired / < 5, (2) timingSafeEqual, (3) CAS consumedAt.
 * Every failure is the same generic "Invalid or expired code". Plus the restore watch token and download tickets.
 */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { deriveKey, hmacHex, safeEqualHex } from './crypto.js';
import * as store from './store.js';

export const OTP_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
export const MAX_SENDS = 3;
export const RESEND_GAP_MS = 60_000;
export const MAX_PER_HOUR = 5;
export const GENERIC = 'Invalid or expired code';

export class OtpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.safe = true;
  }
}

export const otpKey = (master) => deriveKey(master, 'lwos-otp');

export function newCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashCode(key, { id, userId, action, backupId, code }) {
  return hmacHex(key, `${id}:${userId}:${action}:${backupId}:${code}`);
}

export async function createChallenge(db, { master, userId, email, action, backupId, ip = null, userAgent = null, now = new Date(), code = newCode() }) {
  const n = await store.countChallengesSince(db, userId, new Date(now.getTime() - 3_600_000));
  if (n >= MAX_PER_HOUR) throw new OtpError('OTP_RATE', 'Too many codes requested. Try again in an hour.', 429);
  await store.invalidateOpenChallenges(db, userId, action, now);
  const id = store.newId();
  const row = {
    id,
    userId,
    email,
    action,
    backupId,
    codeHash: hashCode(otpKey(master), { id, userId, action, backupId, code }),
    expiresAt: new Date(now.getTime() + OTP_TTL_MS),
    attempts: 0,
    sendCount: 1,
    lastSentAt: now,
    ip: ip ? String(ip).slice(0, 64) : null,
    userAgent: userAgent ? String(userAgent).slice(0, 255) : null,
    createdAt: now,
  };
  await store.insertChallenge(db, row);
  return { challenge: row, code };
}

/** Throws OtpError(GENERIC) on any failure. Returns the consumed challenge. */
export async function verifyChallenge(db, { master, id, userId, action, backupId, code, now = new Date() }) {
  if (!id || !/^\d{6}$/.test(String(code || ''))) throw new OtpError('OTP_INVALID', GENERIC);
  const bumped = await store.bumpChallengeAttempt(db, { id, userId, action, backupId, now, maxAttempts: MAX_ATTEMPTS });
  if (bumped !== 1) throw new OtpError('OTP_INVALID', GENERIC);
  const row = await store.getChallenge(db, id);
  if (!row) throw new OtpError('OTP_INVALID', GENERIC);
  const want = hashCode(otpKey(master), { id, userId, action, backupId, code: String(code) });
  if (!safeEqualHex(want, String(row.codeHash))) throw new OtpError('OTP_INVALID', GENERIC);
  if ((await store.consumeChallenge(db, id, now)) !== 1) throw new OtpError('OTP_INVALID', GENERIC);
  return row;
}

/** New code for an open challenge (≤ 3 sends, ≥ 60 s apart). */
export async function resendChallenge(db, { master, id, userId, now = new Date(), code = newCode() }) {
  const row = await store.getChallenge(db, id);
  if (!row || row.userId !== userId) throw new OtpError('OTP_INVALID', GENERIC);
  const codeHash = hashCode(otpKey(master), { id, userId, action: row.action, backupId: row.backupId, code });
  const n = await store.resendChallengeRow(db, { id, userId, codeHash, now, expiresAt: new Date(now.getTime() + OTP_TTL_MS), maxSends: MAX_SENDS, minGapMs: RESEND_GAP_MS });
  if (n !== 1) throw new OtpError('OTP_RESEND', 'A new code cannot be sent yet (wait a minute, at most 3 codes per request).', 429);
  return { challenge: { ...row, sendCount: row.sendCount + 1, lastSentAt: now }, code };
}

export function attemptsLeft(row) {
  return Math.max(0, MAX_ATTEMPTS - (Number(row?.attempts) || 0));
}

// ── watch token: lets the progress page poll without a session (the user table is in flux) ───────────────────────────
const watchKey = (master) => deriveKey(master, 'lwos-watch');

/** HS256 with HKDF(master, 'lwos-watch'), NOT JWT_ACCESS_SECRET, so verifyJwt can never accept it. */
export function mintWatchToken(master, { userId, jobId }) {
  return jwt.sign({ sub: userId, jobId, typ: 'lwos_watch' }, watchKey(master), { algorithm: 'HS256', expiresIn: '2h' });
}

export function verifyWatchToken(master, token, jobId) {
  if (!token || !master) return null;
  try {
    const p = jwt.verify(String(token), watchKey(master), { algorithms: ['HS256'] });
    if (p?.typ !== 'lwos_watch' || p.jobId !== jobId) return null;
    return p;
  } catch {
    return null;
  }
}

// ── download ticket (60 s, single use, stored as a hash on the challenge row: works across PM2 instances) ───────────
export const TICKET_TTL_MS = 60_000;
export const newTicket = () => crypto.randomBytes(32).toString('base64url');
export const ticketHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
