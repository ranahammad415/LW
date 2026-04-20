import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../setup/test-app.js'
import { seedTestDb, truncateAllTables, connectTestDb, disconnectTestDb } from '../setup/db.js'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_ACCESS_SECRET || 'test-jwt-secret-32-chars-minimum!!'

const TEST_IDS = {
  ownerUserId: '11111111-1111-1111-1111-111111111111',
  pmUserId: '22222222-2222-2222-2222-222222222222',
  teamMemberUserId: '33333333-3333-3333-3333-333333333333',
  contractorUserId: '44444444-4444-4444-4444-444444444444',
  clientUserId: '55555555-5555-5555-5555-555555555555',
  clientAccountId: '77777777-7777-7777-7777-777777777777',
  projectId: '88888888-8888-8888-8888-888888888888',
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

// ── GET /api/projects ──
describe('GET /api/projects', () => {
  it('should return projects array as OWNER', async () => {
    const token = generateAccessToken(TEST_IDS.ownerUserId, 'OWNER')
    const response = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${token}` },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThanOrEqual(1)
    const seeded = body.find((p) => p.id === TEST_IDS.projectId)
    expect(seeded).toBeDefined()
    expect(seeded.name).toBe('Test SEO Campaign')
  })

  it('should return projects for PM assigned as leadPm', async () => {
    const token = generateAccessToken(TEST_IDS.pmUserId, 'PM')
    const response = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${token}` },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    const seeded = body.find((p) => p.id === TEST_IDS.projectId)
    expect(seeded).toBeDefined()
  })

  it('should return 403 for CLIENT role', async () => {
    const token = generateAccessToken(TEST_IDS.clientUserId, 'CLIENT')
    const response = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${token}` },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(403)
    expect(body.message).toBe('Only Owner or PM can list projects')
  })

  it('should return 403 for TEAM_MEMBER role', async () => {
    const token = generateAccessToken(TEST_IDS.teamMemberUserId, 'TEAM_MEMBER')
    const response = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${token}` },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(403)
    expect(body.message).toBe('Only Owner or PM can list projects')
  })
})

// ── POST /api/projects ──
describe('POST /api/projects', () => {
  it('should create a project as PM with valid body', async () => {
    const token = generateAccessToken(TEST_IDS.pmUserId, 'PM')
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: {
        clientId: TEST_IDS.clientAccountId,
        name: 'New Test Project',
        projectType: 'SEO_CAMPAIGN',
      },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(201)
    expect(body).toHaveProperty('id')
    expect(body.name).toBe('New Test Project')
    expect(body.projectType).toBe('SEO_CAMPAIGN')
    expect(body.clientId).toBe(TEST_IDS.clientAccountId)
  })

  it('should return 400 for missing clientId (Zod validation)', async () => {
    const token = generateAccessToken(TEST_IDS.pmUserId, 'PM')
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: {
        name: 'Missing Client',
        projectType: 'SEO_CAMPAIGN',
      },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(400)
    expect(body.message).toBe('Validation failed')
  })

  it('should return 400 for invalid projectType', async () => {
    const token = generateAccessToken(TEST_IDS.pmUserId, 'PM')
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: {
        clientId: TEST_IDS.clientAccountId,
        name: 'Bad Type Project',
        projectType: 'INVALID_TYPE',
      },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(400)
    expect(body.message).toBe('Validation failed')
  })

  it('should return 403 for TEAM_MEMBER creating a project', async () => {
    const token = generateAccessToken(TEST_IDS.teamMemberUserId, 'TEAM_MEMBER')
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: {
        clientId: TEST_IDS.clientAccountId,
        name: 'Forbidden Project',
        projectType: 'SEO_CAMPAIGN',
      },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(403)
    expect(body.message).toBe('Only Owner or PM can create projects')
  })
})

// ── GET /api/projects/:id ──
describe('GET /api/projects/:id', () => {
  it('should return project details as OWNER', async () => {
    const token = generateAccessToken(TEST_IDS.ownerUserId, 'OWNER')
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${TEST_IDS.projectId}`,
      headers: { authorization: `Bearer ${token}` },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(200)
    expect(body.id).toBe(TEST_IDS.projectId)
    expect(body.name).toBe('Test SEO Campaign')
    expect(body).toHaveProperty('client')
    expect(body).toHaveProperty('leadPm')
  })

  it('should return project details as assigned PM', async () => {
    const token = generateAccessToken(TEST_IDS.pmUserId, 'PM')
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${TEST_IDS.projectId}`,
      headers: { authorization: `Bearer ${token}` },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(200)
    expect(body.id).toBe(TEST_IDS.projectId)
  })

  it('should return 403 for CONTRACTOR not assigned to any task in project', async () => {
    const token = generateAccessToken(TEST_IDS.contractorUserId, 'CONTRACTOR')
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${TEST_IDS.projectId}`,
      headers: { authorization: `Bearer ${token}` },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(403)
    expect(body.message).toBe('You do not have access to this project')
  })

  it('should return 404 for non-existent project UUID', async () => {
    const token = generateAccessToken(TEST_IDS.ownerUserId, 'OWNER')
    const response = await app.inject({
      method: 'GET',
      url: '/api/projects/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${token}` },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(404)
    expect(body.message).toBe('Project not found')
  })

  it('should allow TEAM_MEMBER assigned to a task in project', async () => {
    const token = generateAccessToken(TEST_IDS.teamMemberUserId, 'TEAM_MEMBER')
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${TEST_IDS.projectId}`,
      headers: { authorization: `Bearer ${token}` },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(200)
    expect(body.id).toBe(TEST_IDS.projectId)
  })
})
