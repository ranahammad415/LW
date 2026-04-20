import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../setup/test-app.js'
import { seedTestDb, truncateAllTables, connectTestDb, disconnectTestDb } from '../setup/db.js'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_ACCESS_SECRET || 'test-jwt-secret-32-chars-minimum!!'
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-32-chars-min!!'

const TEST_IDS = {
  ownerUserId: '11111111-1111-1111-1111-111111111111',
  pmUserId: '22222222-2222-2222-2222-222222222222',
  clientUserId: '55555555-5555-5555-5555-555555555555',
}

function generateAccessToken(userId, role) {
  return jwt.sign({ sub: userId, role }, JWT_SECRET, { expiresIn: '15m' })
}

function generateRefreshToken(userId) {
  return jwt.sign({ sub: userId, type: 'refresh' }, JWT_REFRESH_SECRET, { expiresIn: '7d' })
}

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

// ── POST /api/auth/login ──
describe('POST /api/auth/login', () => {
  it('should login with valid owner credentials and return accessToken + user', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner@localwaves.test', password: 'password123' },
      headers: { 'content-type': 'application/json' },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(200)
    expect(body).toHaveProperty('accessToken')
    expect(body).toHaveProperty('user')
    expect(body.user.id).toBe(TEST_IDS.ownerUserId)
    expect(body.user.email).toBe('owner@localwaves.test')
    expect(body.user.role).toBe('OWNER')
    expect(body.user.name).toBe('Test Owner')
  })

  it('should return 401 for wrong password', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner@localwaves.test', password: 'wrongpassword' },
      headers: { 'content-type': 'application/json' },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(401)
    expect(body.message).toBe('Invalid email or password')
  })

  it('should return 400 for missing email field', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'password123' },
      headers: { 'content-type': 'application/json' },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(400)
    expect(body.message).toBe('Validation failed')
  })

  it('should return 401 for non-existent email', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@localwaves.test', password: 'password123' },
      headers: { 'content-type': 'application/json' },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(401)
    expect(body.message).toBe('Invalid email or password')
  })
})

// ── POST /api/auth/refresh ──
describe('POST /api/auth/refresh', () => {
  it('should return new accessToken with valid refresh cookie', async () => {
    const refreshToken = generateRefreshToken(TEST_IDS.ownerUserId)
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { refreshToken },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(200)
    expect(body).toHaveProperty('accessToken')
    expect(typeof body.accessToken).toBe('string')
  })

  it('should return 401 for expired refresh token', async () => {
    const expiredToken = jwt.sign(
      { sub: TEST_IDS.ownerUserId, type: 'refresh' },
      JWT_REFRESH_SECRET,
      { expiresIn: '0s' }
    )
    // Small delay to ensure token is expired
    await new Promise((resolve) => setTimeout(resolve, 50))
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { refreshToken: expiredToken },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(401)
    expect(body.message).toBe('Invalid or expired refresh token')
  })

  it('should return 401 for invalid refresh token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { refreshToken: 'totally-invalid-token' },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(401)
    expect(body.message).toBe('Invalid or expired refresh token')
  })

  it('should return 401 when refresh cookie is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(401)
    expect(body.message).toBe('Refresh token missing')
  })
})

// ── GET /api/users/me ──
describe('GET /api/users/me', () => {
  it('should return user profile with valid Bearer token', async () => {
    const token = generateAccessToken(TEST_IDS.ownerUserId, 'OWNER')
    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: { authorization: `Bearer ${token}` },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(200)
    expect(body.id).toBe(TEST_IDS.ownerUserId)
    expect(body.email).toBe('owner@localwaves.test')
    expect(body.role).toBe('OWNER')
    expect(body.name).toBe('Test Owner')
  })

  it('should return client profile with clientAccountIds for CLIENT user', async () => {
    const token = generateAccessToken(TEST_IDS.clientUserId, 'CLIENT')
    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: { authorization: `Bearer ${token}` },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(200)
    expect(body.id).toBe(TEST_IDS.clientUserId)
    expect(body.role).toBe('CLIENT')
    expect(Array.isArray(body.clientAccountIds)).toBe(true)
    expect(body.clientAccountIds).toContain('77777777-7777-7777-7777-777777777777')
  })

  it('should return 401 without authorization header', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me',
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(401)
    expect(body.message).toBe('Missing or invalid authorization token')
  })

  it('should return 401 with invalid token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: { authorization: 'Bearer invalid-token' },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(401)
    expect(body.message).toBe('Invalid token')
  })
})
