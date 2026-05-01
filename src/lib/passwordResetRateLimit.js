/**
 * In-memory sliding-window rate limiter for password-reset requests.
 *
 * Two independent buckets:
 *   - per-email  (max 3 requests / hour)
 *   - per-ip     (max 10 requests / hour)
 *
 * No external Redis required. Counters reset automatically as the window
 * slides. Cleanup: stale entries are pruned on each call.
 *
 * NOTE: in a multi-process deployment (PM2 cluster, multiple containers) this
 * limiter is per-process. For Localwaves' single-process Hostinger setup that
 * is acceptable; switch to Redis if scaling out.
 */

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_PER_EMAIL = 3;
const MAX_PER_IP = 10;

const emailHits = new Map(); // emailLower -> number[] (timestamps)
const ipHits = new Map();    // ip -> number[]

function prune(map, now) {
  for (const [key, hits] of map.entries()) {
    const fresh = hits.filter((t) => now - t < WINDOW_MS);
    if (fresh.length === 0) map.delete(key);
    else map.set(key, fresh);
  }
}

function check(map, key, max, now) {
  const hits = (map.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= max) return { allowed: false, retryAfterMs: WINDOW_MS - (now - hits[0]) };
  hits.push(now);
  map.set(key, hits);
  return { allowed: true };
}

/**
 * @param {{ email: string, ip: string }} opts
 * @returns {{ allowed: boolean, retryAfterMs?: number, reason?: 'email' | 'ip' }}
 */
export function checkPasswordResetRateLimit({ email, ip }) {
  const now = Date.now();
  // Prune occasionally to keep memory bounded
  if (Math.random() < 0.05) {
    prune(emailHits, now);
    prune(ipHits, now);
  }

  const ipKey = ip || 'unknown';
  const ipResult = check(ipHits, ipKey, MAX_PER_IP, now);
  if (!ipResult.allowed) return { allowed: false, retryAfterMs: ipResult.retryAfterMs, reason: 'ip' };

  const emailKey = String(email || '').trim().toLowerCase();
  if (emailKey) {
    const emailResult = check(emailHits, emailKey, MAX_PER_EMAIL, now);
    if (!emailResult.allowed) {
      return { allowed: false, retryAfterMs: emailResult.retryAfterMs, reason: 'email' };
    }
  }

  return { allowed: true };
}

/** Test-only helper: clear all counters. */
export function _resetPasswordResetRateLimitForTests() {
  emailHits.clear();
  ipHits.clear();
}
