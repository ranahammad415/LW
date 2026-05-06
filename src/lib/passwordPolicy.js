import bcrypt from 'bcrypt';

// Centralised password hashing/validation policy.
// Historically different call-sites used rounds 10 or 12 — standardise on 12.
export const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

/**
 * Validates password complexity. Returns { ok: true } or { ok: false, message }.
 * Rules: min length, max length, must contain at least 3 of the 4 categories:
 *   lowercase, uppercase, digit, symbol.
 * Also rejects obvious weak patterns (all-digits, single repeated character).
 */
export function validatePasswordStrength(password) {
  if (typeof password !== 'string') {
    return { ok: false, message: 'Password is required' };
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` };
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return { ok: false, message: 'Password is too long' };
  }
  const categories = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;
  if (categories < 3) {
    return {
      ok: false,
      message: 'Password must include at least 3 of: lowercase, uppercase, digit, symbol',
    };
  }
  if (/^(.)\1+$/.test(password)) {
    return { ok: false, message: 'Password is too weak' };
  }
  if (/^[0-9]+$/.test(password)) {
    return { ok: false, message: 'Password cannot be all digits' };
  }
  return { ok: true };
}

export function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}
