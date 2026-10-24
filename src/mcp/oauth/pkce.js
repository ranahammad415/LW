/**
 * PKCE (RFC 7636), S256 only (OAuth 2.1 / MCP authorization: `plain` is rejected).
 */
import { createHash, timingSafeEqual } from 'crypto';

/** code_verifier / code_challenge alphabet and length (43–128 unreserved characters). */
const PKCE_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidCodeVerifier(v) {
  return typeof v === 'string' && PKCE_RE.test(v);
}

/** A S256 challenge is base64url(sha256) = 43 chars, but accept the RFC range so odd clients get a clear error later. */
export function isValidCodeChallenge(v) {
  return typeof v === 'string' && PKCE_RE.test(v);
}

export function s256Challenge(verifier) {
  return createHash('sha256').update(String(verifier), 'ascii').digest('base64url');
}

/** Constant-time check that base64url(sha256(verifier)) equals the stored challenge. */
export function verifyPkceS256(verifier, challenge) {
  if (!isValidCodeVerifier(verifier) || typeof challenge !== 'string') return false;
  const a = Buffer.from(s256Challenge(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}
