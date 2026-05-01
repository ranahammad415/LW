import { describe, it, expect, beforeEach } from 'vitest'
import {
  checkPasswordResetRateLimit,
  _resetPasswordResetRateLimitForTests,
} from '../../../src/lib/passwordResetRateLimit.js'

describe('checkPasswordResetRateLimit', () => {
  beforeEach(() => {
    _resetPasswordResetRateLimitForTests()
  })

  it('allows the first request for a fresh email + ip', () => {
    const r = checkPasswordResetRateLimit({ email: 'a@example.com', ip: '1.2.3.4' })
    expect(r.allowed).toBe(true)
  })

  it('allows up to 3 requests per email then blocks the 4th', () => {
    const email = 'b@example.com'
    expect(checkPasswordResetRateLimit({ email, ip: '1.1.1.1' }).allowed).toBe(true)
    expect(checkPasswordResetRateLimit({ email, ip: '1.1.1.2' }).allowed).toBe(true)
    expect(checkPasswordResetRateLimit({ email, ip: '1.1.1.3' }).allowed).toBe(true)
    const blocked = checkPasswordResetRateLimit({ email, ip: '1.1.1.4' })
    expect(blocked.allowed).toBe(false)
    expect(blocked.reason).toBe('email')
    expect(blocked.retryAfterMs).toBeGreaterThan(0)
  })

  it('allows up to 10 requests per ip then blocks the 11th', () => {
    const ip = '9.9.9.9'
    for (let i = 0; i < 10; i += 1) {
      const r = checkPasswordResetRateLimit({ email: `u${i}@example.com`, ip })
      expect(r.allowed).toBe(true)
    }
    const blocked = checkPasswordResetRateLimit({ email: 'u11@example.com', ip })
    expect(blocked.allowed).toBe(false)
    expect(blocked.reason).toBe('ip')
  })

  it('treats different emails as independent buckets', () => {
    expect(checkPasswordResetRateLimit({ email: 'x@example.com', ip: '2.2.2.1' }).allowed).toBe(true)
    expect(checkPasswordResetRateLimit({ email: 'x@example.com', ip: '2.2.2.2' }).allowed).toBe(true)
    expect(checkPasswordResetRateLimit({ email: 'x@example.com', ip: '2.2.2.3' }).allowed).toBe(true)
    // Different email — should still be allowed even though previous email is exhausted
    expect(checkPasswordResetRateLimit({ email: 'y@example.com', ip: '2.2.2.4' }).allowed).toBe(true)
  })

  it('normalizes email casing (X@Y.com == x@y.com)', () => {
    expect(checkPasswordResetRateLimit({ email: 'CASE@example.com', ip: '3.3.3.1' }).allowed).toBe(true)
    expect(checkPasswordResetRateLimit({ email: 'case@example.com', ip: '3.3.3.2' }).allowed).toBe(true)
    expect(checkPasswordResetRateLimit({ email: 'Case@Example.com', ip: '3.3.3.3' }).allowed).toBe(true)
    const blocked = checkPasswordResetRateLimit({ email: 'case@example.com', ip: '3.3.3.4' })
    expect(blocked.allowed).toBe(false)
    expect(blocked.reason).toBe('email')
  })
})
