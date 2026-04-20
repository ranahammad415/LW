import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../setup/test-app.js'
import { seedTestDb, truncateAllTables, connectTestDb, disconnectTestDb } from '../setup/db.js'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_ACCESS_SECRET || 'test-jwt-secret-32-chars-minimum!!'

const TEST_IDS = {
  ownerUserId: '11111111-1111-1111-1111-111111111111',
  pmUserId: '22222222-2222-2222-2222-222222222222',
  teamMemberUserId: '33333333-3333-3333-3333-333333333333',
  clientUserId: '55555555-5555-5555-5555-555555555555',
  packageId: '66666666-6666-6666-6666-666666666666',
  clientAccountId: '77777777-7777-7777-7777-777777777777',
}

function generateAccessToken(userId, role) {
  return jwt.sign({ sub: userId, role }, JWT_SECRET, { expiresIn: '15m' })
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

// ── GET /api/admin/dashboard ──
describe('GET /api/admin/dashboard', () => {
  it('should return dashboard metrics as OWNER', async () => {
    const token = generateAccessToken(TEST_IDS.ownerUserId, 'OWNER')
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/dashboard',
      headers: { authorization: `Bearer ${token}` },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(200)
    expect(body).toHaveProperty('metrics')
    expect(body).toHaveProperty('clientHealthMap')
    expect(body).toHaveProperty('openIssues')
    expect(body).toHaveProperty('recentlyCompletedTasks')
    expect(body.metrics).toHaveProperty('activeClients')
    expect(body.metrics).toHaveProperty('tasksDueToday')
    expect(body.metrics).toHaveProperty('deliverablesPending')
    expect(body.metrics).toHaveProperty('teamOnTimeRate')
    expect(body.metrics).toHaveProperty('atRiskClients')
    expect(Array.isArray(body.clientHealthMap)).toBe(true)
  })

  it('should return 403 for PM', async () => {
    const token = generateAccessToken(TEST_IDS.pmUserId, 'PM')
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/dashboard',
      headers: { authorization: `Bearer ${token}` },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(403)
    expect(body.message).toBe('Admin access required')
  })

  it('should return 403 for TEAM_MEMBER', async () => {
    const token = generateAccessToken(TEST_IDS.teamMemberUserId, 'TEAM_MEMBER')
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/dashboard',
      headers: { authorization: `Bearer ${token}` },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(403)
    expect(body.message).toBe('Admin access required')
  })

  it('should return 401 without auth token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/dashboard',
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(401)
    expect(body.message).toBe('Missing or invalid authorization token')
  })
})

// ── GET /api/admin/clients ──
describe('GET /api/admin/clients', () => {
  it('should return clients array as OWNER', async () => {
    const token = generateAccessToken(TEST_IDS.ownerUserId, 'OWNER')
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/clients',
      headers: { authorization: `Bearer ${token}` },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThanOrEqual(1)
    const seeded = body.find((c) => c.id === TEST_IDS.clientAccountId)
    expect(seeded).toBeDefined()
    expect(seeded.agencyName).toBe('Test Agency')
  })

  it('should return 403 for PM', async () => {
    const token = generateAccessToken(TEST_IDS.pmUserId, 'PM')
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/clients',
      headers: { authorization: `Bearer ${token}` },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(403)
    expect(body.message).toBe('Admin access required')
  })
})

// ── POST /api/admin/clients ──
describe('POST /api/admin/clients', () => {
  it('should create a client as OWNER with valid body', async () => {
    const token = generateAccessToken(TEST_IDS.ownerUserId, 'OWNER')
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/clients',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: {
        agencyName: 'New Client Agency',
        contactName: 'John Doe',
        contactEmail: 'john@newclient.test',
        packageId: TEST_IDS.packageId,
        leadPmId: TEST_IDS.pmUserId,
      },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(201)
    expect(body).toHaveProperty('id')
    expect(body.agencyName).toBe('New Client Agency')
    expect(body).toHaveProperty('primaryContact')
    expect(body.primaryContact.email).toBe('john@newclient.test')
    expect(body.primaryContact.name).toBe('John Doe')
    expect(body).toHaveProperty('tempPassword')
  })

  it('should return 400 for missing agencyName', async () => {
    const token = generateAccessToken(TEST_IDS.ownerUserId, 'OWNER')
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/clients',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: {
        contactName: 'John Doe',
        contactEmail: 'john2@newclient.test',
      },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(400)
    expect(body.message).toBe('Validation failed')
  })

  it('should return 400 for missing contactName', async () => {
    const token = generateAccessToken(TEST_IDS.ownerUserId, 'OWNER')
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/clients',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: {
        agencyName: 'Another Agency',
        contactEmail: 'someone@test.com',
      },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(400)
    expect(body.message).toBe('Validation failed')
  })

  it('should return 400 for missing contactEmail', async () => {
    const token = generateAccessToken(TEST_IDS.ownerUserId, 'OWNER')
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/clients',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: {
        agencyName: 'Another Agency',
        contactName: 'Jane Doe',
      },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(400)
    expect(body.message).toBe('Validation failed')
  })

  it('should return 400 for invalid contactEmail', async () => {
    const token = generateAccessToken(TEST_IDS.ownerUserId, 'OWNER')
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/clients',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: {
        agencyName: 'Another Agency',
        contactName: 'Jane Doe',
        contactEmail: 'not-an-email',
      },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(400)
    expect(body.message).toBe('Validation failed')
  })

  it('should return 403 for PM creating a client', async () => {
    const token = generateAccessToken(TEST_IDS.pmUserId, 'PM')
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/clients',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: {
        agencyName: 'PM Forbidden Client',
        contactName: 'Test',
        contactEmail: 'pm-forbidden@test.com',
      },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(403)
    expect(body.message).toBe('Admin access required')
  })
})

// ── PATCH /api/admin/clients/:id ──
describe('PATCH /api/admin/clients/:id', () => {
  it('should update client as OWNER', async () => {
    const token = generateAccessToken(TEST_IDS.ownerUserId, 'OWNER')
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/admin/clients/${TEST_IDS.clientAccountId}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: {
        agencyName: 'Updated Agency Name',
        industry: 'Healthcare',
      },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(200)
    expect(body.id).toBe(TEST_IDS.clientAccountId)
    expect(body.agencyName).toBe('Updated Agency Name')
    expect(body.industry).toBe('Healthcare')
  })

  it('should return 404 for non-existent client', async () => {
    const token = generateAccessToken(TEST_IDS.ownerUserId, 'OWNER')
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/admin/clients/00000000-0000-0000-0000-000000000000',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: { agencyName: 'Ghost Client' },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(404)
    expect(body.message).toBe('Client not found')
  })

  it('should return 403 for PM trying to update client', async () => {
    const token = generateAccessToken(TEST_IDS.pmUserId, 'PM')
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/admin/clients/${TEST_IDS.clientAccountId}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: { agencyName: 'PM Forbidden Update' },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(403)
    expect(body.message).toBe('Admin access required')
  })

  it('should update analyticsGoogleEmail', async () => {
    const token = generateAccessToken(TEST_IDS.ownerUserId, 'OWNER')
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/admin/clients/${TEST_IDS.clientAccountId}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: {
        analyticsGoogleEmail: 'analytics@client.test',
      },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(200)
    expect(body.analyticsGoogleEmail).toBe('analytics@client.test')
  })
})
