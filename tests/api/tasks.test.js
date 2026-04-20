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
  projectId: '88888888-8888-8888-8888-888888888888',
  task1Id: '99999999-9999-9999-9999-999999999991',
  task2Id: '99999999-9999-9999-9999-999999999992',
  task3Id: '99999999-9999-9999-9999-999999999993',
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

// ── GET /api/tasks ──
describe('GET /api/tasks', () => {
  it('should return tasks array as OWNER', async () => {
    const token = generateAccessToken(TEST_IDS.ownerUserId, 'OWNER')
    const response = await app.inject({
      method: 'GET',
      url: '/api/tasks',
      headers: { authorization: `Bearer ${token}` },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThanOrEqual(1)
  })

  it('should return tasks visible to PM', async () => {
    const token = generateAccessToken(TEST_IDS.pmUserId, 'PM')
    const response = await app.inject({
      method: 'GET',
      url: '/api/tasks',
      headers: { authorization: `Bearer ${token}` },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(200)
    expect(Array.isArray(body)).toBe(true)
  })

  it('should return assigned tasks for TEAM_MEMBER', async () => {
    const token = generateAccessToken(TEST_IDS.teamMemberUserId, 'TEAM_MEMBER')
    const response = await app.inject({
      method: 'GET',
      url: '/api/tasks',
      headers: { authorization: `Bearer ${token}` },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    // Team member is assigned to task1 and task2
    expect(body.length).toBeGreaterThanOrEqual(1)
  })

  it('should return 403 for CLIENT role', async () => {
    const token = generateAccessToken(TEST_IDS.clientUserId, 'CLIENT')
    const response = await app.inject({
      method: 'GET',
      url: '/api/tasks',
      headers: { authorization: `Bearer ${token}` },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(403)
    expect(body.message).toBe('Forbidden')
  })
})

// ── POST /api/tasks ──
describe('POST /api/tasks', () => {
  it('should create a task as PM with valid body', async () => {
    const token = generateAccessToken(TEST_IDS.pmUserId, 'PM')
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: {
        projectId: TEST_IDS.projectId,
        title: 'New test task',
        taskType: 'KEYWORD_RESEARCH',
      },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(201)
    expect(body).toHaveProperty('id')
    expect(body.title).toBe('New test task')
    expect(body.status).toBe('TO_DO')
  })

  it('should return 400 for missing title', async () => {
    const token = generateAccessToken(TEST_IDS.pmUserId, 'PM')
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: {
        projectId: TEST_IDS.projectId,
        taskType: 'KEYWORD_RESEARCH',
      },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(400)
    expect(body.message).toBe('Validation failed')
  })

  it('should return 400 for invalid priority', async () => {
    const token = generateAccessToken(TEST_IDS.pmUserId, 'PM')
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: {
        projectId: TEST_IDS.projectId,
        title: 'Bad priority task',
        taskType: 'SEO_AUDIT',
        priority: 'INVALID_PRIORITY',
      },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(400)
    expect(body.message).toBe('Validation failed')
  })

  it('should return 403 for TEAM_MEMBER creating a task', async () => {
    const token = generateAccessToken(TEST_IDS.teamMemberUserId, 'TEAM_MEMBER')
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: {
        projectId: TEST_IDS.projectId,
        title: 'Forbidden task',
        taskType: 'KEYWORD_RESEARCH',
      },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(403)
    expect(body.message).toBe('Only Owner or PM can create tasks')
  })

  it('should create a task as OWNER', async () => {
    const token = generateAccessToken(TEST_IDS.ownerUserId, 'OWNER')
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: {
        projectId: TEST_IDS.projectId,
        title: 'Owner created task',
        taskType: 'ANALYTICS',
        priority: 'HIGH',
      },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(201)
    expect(body.title).toBe('Owner created task')
  })
})

// ── PATCH /api/tasks/:id/status ──
describe('PATCH /api/tasks/:id/status', () => {
  it('should update task status with valid transition as OWNER', async () => {
    const token = generateAccessToken(TEST_IDS.ownerUserId, 'OWNER')
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${TEST_IDS.task1Id}/status`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: { status: 'IN_PROGRESS' },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(200)
    expect(body.id).toBe(TEST_IDS.task1Id)
    expect(body.status).toBe('IN_PROGRESS')
  })

  it('should return 400 for invalid status value', async () => {
    const token = generateAccessToken(TEST_IDS.ownerUserId, 'OWNER')
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${TEST_IDS.task1Id}/status`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: { status: 'NOT_A_VALID_STATUS' },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(400)
    expect(body.message).toBe('Validation failed')
  })

  it('should return 404 for non-existent task', async () => {
    const token = generateAccessToken(TEST_IDS.ownerUserId, 'OWNER')
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/00000000-0000-0000-0000-000000000000/status',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: { status: 'IN_PROGRESS' },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(404)
    expect(body.message).toBe('Task not found')
  })

  it('should allow assigned TEAM_MEMBER to update status', async () => {
    const token = generateAccessToken(TEST_IDS.teamMemberUserId, 'TEAM_MEMBER')
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${TEST_IDS.task2Id}/status`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: { status: 'NEEDS_REVIEW' },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(200)
    expect(body.status).toBe('NEEDS_REVIEW')
  })
})

// ── POST /api/tasks/:id/comments ──
describe('POST /api/tasks/:id/comments', () => {
  it('should add a comment as OWNER', async () => {
    const token = generateAccessToken(TEST_IDS.ownerUserId, 'OWNER')
    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${TEST_IDS.task1Id}/comments`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: { content: 'This is a test comment' },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(201)
    expect(body).toHaveProperty('id')
    expect(body.content).toBe('This is a test comment')
    expect(body.taskId).toBe(TEST_IDS.task1Id)
    expect(body.user).toHaveProperty('id')
    expect(body.user).toHaveProperty('name')
  })

  it('should return 400 for empty content', async () => {
    const token = generateAccessToken(TEST_IDS.ownerUserId, 'OWNER')
    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${TEST_IDS.task1Id}/comments`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: { content: '' },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(400)
    expect(body.message).toBe('content is required')
  })

  it('should return 400 for missing content', async () => {
    const token = generateAccessToken(TEST_IDS.ownerUserId, 'OWNER')
    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${TEST_IDS.task1Id}/comments`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: {},
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(400)
    expect(body.message).toBe('content is required')
  })

  it('should return 404 for non-existent task', async () => {
    const token = generateAccessToken(TEST_IDS.ownerUserId, 'OWNER')
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/00000000-0000-0000-0000-000000000000/comments',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: { content: 'Comment on missing task' },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(404)
    expect(body.message).toBe('Task not found')
  })
})

// ── DELETE /api/tasks/:id ──
describe('DELETE /api/tasks/:id', () => {
  it('should return 403 for TEAM_MEMBER trying to delete', async () => {
    const token = generateAccessToken(TEST_IDS.teamMemberUserId, 'TEAM_MEMBER')
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/tasks/${TEST_IDS.task1Id}`,
      headers: { authorization: `Bearer ${token}` },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(403)
    expect(body.message).toBe('PM or Owner access required')
  })

  it('should delete task as PM (lead PM of the project)', async () => {
    // First create a task to delete so we don't affect other tests
    const pmToken = generateAccessToken(TEST_IDS.pmUserId, 'PM')
    const createResp = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: {
        authorization: `Bearer ${pmToken}`,
        'content-type': 'application/json',
      },
      payload: {
        projectId: TEST_IDS.projectId,
        title: 'Task to delete',
        taskType: 'KEYWORD_RESEARCH',
      },
    })
    const created = JSON.parse(createResp.body)
    expect(createResp.statusCode).toBe(201)

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/tasks/${created.id}`,
      headers: { authorization: `Bearer ${pmToken}` },
    })
    expect(response.statusCode).toBe(200)
  })

  it('should return 404 for non-existent task', async () => {
    const token = generateAccessToken(TEST_IDS.ownerUserId, 'OWNER')
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/tasks/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${token}` },
    })
    const body = JSON.parse(response.body)
    expect(response.statusCode).toBe(404)
    expect(body.message).toBe('Task not found')
  })
})
