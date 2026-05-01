import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import crypto from 'crypto'
import bcrypt from 'bcrypt'
import { buildApp } from '../setup/test-app.js'
import {
  seedTestDb,
  truncateAllTables,
  connectTestDb,
  disconnectTestDb,
  prisma,
} from '../setup/db.js'
import { _resetPasswordResetRateLimitForTests } from '../../src/lib/passwordResetRateLimit.js'

// Mock the email helper so tests do not depend on SMTP configuration. We
// inspect the mock to verify a delivery was attempted, but never send a real
// email.
vi.mock('../../src/lib/passwordResetEmail.js', () => ({
  sendPasswordResetEmail: vi.fn(async () => ({ success: true })),
}))
const { sendPasswordResetEmail } = await import('../../src/lib/passwordResetEmail.js')

const TEST_OWNER_ID = '11111111-1111-1111-1111-111111111111'
const TEST_OWNER_EMAIL = 'owner@test.com'

let app

beforeAll(async () => {
  await connectTestDb()
  await truncateAllTables()
  await seedTestDb()
  app = await buildApp()
})

afterAll(async () => {
  await truncateAllTables()
  await app.close()
  await disconnectTestDb()
})

beforeEach(async () => {
  _resetPasswordResetRateLimitForTests()
  // Clear any tokens from previous tests
  await prisma.passwordResetToken.deleteMany({})
  vi.clearAllMocks()
})

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

// ── POST /api/auth/forgot-password ──
describe('POST /api/auth/forgot-password', () => {
  it('returns 200 + generic message and persists a token for an existing user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/forgot-password',
      payload: { email: TEST_OWNER_EMAIL },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.message).toMatch(/if an account exists/i)

    const tokens = await prisma.passwordResetToken.findMany({ where: { userId: TEST_OWNER_ID } })
    expect(tokens.length).toBe(1)
    expect(tokens[0].usedAt).toBeNull()
    expect(tokens[0].expiresAt.getTime()).toBeGreaterThan(Date.now())
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1)
  })

  it('returns the same generic 200 response when the email is not registered (no enumeration)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/forgot-password',
      payload: { email: 'nobody@example.com' },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.message).toMatch(/if an account exists/i)
    expect(sendPasswordResetEmail).not.toHaveBeenCalled()
  })

  it('rejects malformed email with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/forgot-password',
      payload: { email: 'not-an-email' },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('invalidates prior pending tokens for the same user when a new one is requested', async () => {
    // First request
    await app.inject({
      method: 'POST',
      url: '/api/auth/forgot-password',
      payload: { email: TEST_OWNER_EMAIL },
      headers: { 'content-type': 'application/json' },
    })
    // Second request
    await app.inject({
      method: 'POST',
      url: '/api/auth/forgot-password',
      payload: { email: TEST_OWNER_EMAIL },
      headers: { 'content-type': 'application/json' },
    })

    const tokens = await prisma.passwordResetToken.findMany({
      where: { userId: TEST_OWNER_ID },
      orderBy: { createdAt: 'asc' },
    })
    expect(tokens.length).toBe(2)
    // The earlier token must be marked used; the latest must still be pending
    expect(tokens[0].usedAt).not.toBeNull()
    expect(tokens[1].usedAt).toBeNull()
  })

  it('rate-limits more than 3 requests/hour for the same email with 429', async () => {
    for (let i = 0; i < 3; i += 1) {
      const ok = await app.inject({
        method: 'POST',
        url: '/api/auth/forgot-password',
        payload: { email: TEST_OWNER_EMAIL },
        headers: { 'content-type': 'application/json' },
      })
      expect(ok.statusCode).toBe(200)
    }
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/forgot-password',
      payload: { email: TEST_OWNER_EMAIL },
      headers: { 'content-type': 'application/json' },
    })
    expect(blocked.statusCode).toBe(429)
  })
})

// ── POST /api/auth/validate-reset-token ──
describe('POST /api/auth/validate-reset-token', () => {
  async function createValidToken() {
    const token = crypto.randomBytes(32).toString('base64url')
    await prisma.passwordResetToken.create({
      data: {
        userId: TEST_OWNER_ID,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    })
    return token
  }

  it('returns valid:true with masked email for a fresh token', async () => {
    const token = await createValidToken()
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/validate-reset-token',
      payload: { token },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.valid).toBe(true)
    expect(body.email).toMatch(/^o.*@test\.com$/)
  })

  it('returns valid:false for a token that does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/validate-reset-token',
      payload: { token: 'totally-bogus-token-value' },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).valid).toBe(false)
  })

  it('returns valid:false for an expired token', async () => {
    const token = crypto.randomBytes(32).toString('base64url')
    await prisma.passwordResetToken.create({
      data: {
        userId: TEST_OWNER_ID,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() - 60 * 1000),
      },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/validate-reset-token',
      payload: { token },
      headers: { 'content-type': 'application/json' },
    })
    expect(JSON.parse(res.body).valid).toBe(false)
  })

  it('returns valid:false for a token already used', async () => {
    const token = crypto.randomBytes(32).toString('base64url')
    await prisma.passwordResetToken.create({
      data: {
        userId: TEST_OWNER_ID,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        usedAt: new Date(),
      },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/validate-reset-token',
      payload: { token },
      headers: { 'content-type': 'application/json' },
    })
    expect(JSON.parse(res.body).valid).toBe(false)
  })
})

// ── POST /api/auth/reset-password ──
describe('POST /api/auth/reset-password', () => {
  async function createValidToken() {
    const token = crypto.randomBytes(32).toString('base64url')
    await prisma.passwordResetToken.create({
      data: {
        userId: TEST_OWNER_ID,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    })
    return token
  }

  it('updates the password, marks the token used, and bumps tokenVersion', async () => {
    const token = await createValidToken()
    const before = await prisma.user.findUnique({ where: { id: TEST_OWNER_ID } })

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, newPassword: 'NewSecure123!' },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)

    const after = await prisma.user.findUnique({ where: { id: TEST_OWNER_ID } })
    expect(after.tokenVersion).toBe((before.tokenVersion ?? 0) + 1)
    expect(await bcrypt.compare('NewSecure123!', after.passwordHash)).toBe(true)

    const tokenRow = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(token) },
    })
    expect(tokenRow.usedAt).not.toBeNull()
  })

  it('rejects a token that has already been consumed', async () => {
    const token = await createValidToken()
    // Consume it once
    await app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, newPassword: 'FirstPass123' },
      headers: { 'content-type': 'application/json' },
    })
    // Try again
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, newPassword: 'SecondPass123' },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects passwords shorter than 8 characters', async () => {
    const token = await createValidToken()
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, newPassword: 'short' },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects an unknown token with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token: 'no-such-token', newPassword: 'GoodPassword1' },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('invalidates other pending tokens for the same user atomically', async () => {
    const tokenA = await createValidToken()
    const tokenB = await createValidToken()

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token: tokenA, newPassword: 'AnotherStrong1!' },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)

    const rowA = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(tokenA) } })
    const rowB = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(tokenB) } })
    expect(rowA.usedAt).not.toBeNull()
    expect(rowB.usedAt).not.toBeNull()
  })
})
