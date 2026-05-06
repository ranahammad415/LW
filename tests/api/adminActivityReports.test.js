import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../setup/test-app.js'
import { seedTestDb, truncateAllTables, connectTestDb, disconnectTestDb, prisma } from '../setup/db.js'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_ACCESS_SECRET || 'test-jwt-secret-32-chars-minimum!!'

const TEST_IDS = {
  ownerUserId: '11111111-1111-1111-1111-111111111111',
  pmUserId: '22222222-2222-2222-2222-222222222222',
  projectId: '88888888-8888-8888-8888-888888888888',
}

function tokenFor(userId, role) {
  return jwt.sign({ sub: userId, role }, JWT_SECRET, { expiresIn: '15m' })
}

let app
const MONTH = '2026-04'

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

// ── Auth / authz ──
describe('Activity reports: auth & validation', () => {
  it('requires a token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/admin/activity-reports/projects?month=${MONTH}`,
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects non-owner role', async () => {
    const token = tokenFor(TEST_IDS.pmUserId, 'PM')
    const res = await app.inject({
      method: 'GET',
      url: `/api/admin/activity-reports/projects?month=${MONTH}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('rejects invalid month format on listing', async () => {
    const token = tokenFor(TEST_IDS.ownerUserId, 'OWNER')
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/activity-reports/projects?month=not-a-month',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects invalid month format on generate', async () => {
    const token = tokenFor(TEST_IDS.ownerUserId, 'OWNER')
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/activity-reports/generate',
      headers: { authorization: `Bearer ${token}` },
      payload: { month: '2026/04' },
    })
    expect(res.statusCode).toBe(400)
  })
})

// ── List projects ──
describe('GET /api/admin/activity-reports/projects', () => {
  it('returns active projects with null cachedReport when no reports exist', async () => {
    const token = tokenFor(TEST_IDS.ownerUserId, 'OWNER')
    const res = await app.inject({
      method: 'GET',
      url: `/api/admin/activity-reports/projects?month=${MONTH}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.month).toBe(MONTH)
    expect(body.agency).toBeNull()
    expect(Array.isArray(body.projects)).toBe(true)
    const seeded = body.projects.find((p) => p.id === TEST_IDS.projectId)
    expect(seeded).toBeTruthy()
    expect(seeded.cachedReport).toBeNull()
  })
})

// ── Generate + fetch + export ──
describe('POST /api/admin/activity-reports/generate', () => {
  it('generates an AGENCY report using the deterministic fallback', async () => {
    const token = tokenFor(TEST_IDS.ownerUserId, 'OWNER')
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/activity-reports/generate',
      headers: { authorization: `Bearer ${token}` },
      payload: { month: MONTH },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.id).toBeTruthy()
    expect(body.scope).toBe('AGENCY')
    expect(body.projectId).toBeNull()
    expect(body.month).toBe(MONTH)
    expect(typeof body.narrativeMd).toBe('string')
    expect(body.narrativeMd.length).toBeGreaterThan(0)
    expect(body.generatedBy).toBe(TEST_IDS.ownerUserId)
  })

  it('generates a PROJECT report for a seeded project', async () => {
    const token = tokenFor(TEST_IDS.ownerUserId, 'OWNER')
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/activity-reports/generate',
      headers: { authorization: `Bearer ${token}` },
      payload: { month: MONTH, projectId: TEST_IDS.projectId },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.scope).toBe('PROJECT')
    expect(body.projectId).toBe(TEST_IDS.projectId)
    expect(body.month).toBe(MONTH)
    expect(body.factsJson).toBeTruthy()
    expect(body.factsJson.project?.id).toBe(TEST_IDS.projectId)
  })

  it('upserts on (scope, projectId, month) — regenerating keeps the same id', async () => {
    const token = tokenFor(TEST_IDS.ownerUserId, 'OWNER')
    const first = await app.inject({
      method: 'POST',
      url: '/api/admin/activity-reports/generate',
      headers: { authorization: `Bearer ${token}` },
      payload: { month: MONTH, projectId: TEST_IDS.projectId },
    })
    const firstBody = JSON.parse(first.body)

    const second = await app.inject({
      method: 'POST',
      url: '/api/admin/activity-reports/generate',
      headers: { authorization: `Bearer ${token}` },
      payload: { month: MONTH, projectId: TEST_IDS.projectId },
    })
    expect(second.statusCode).toBe(200)
    const secondBody = JSON.parse(second.body)
    expect(secondBody.id).toBe(firstBody.id)

    // and the cached listing should now report this project as having a report
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/admin/activity-reports/projects?month=${MONTH}`,
      headers: { authorization: `Bearer ${token}` },
    })
    const list = JSON.parse(listRes.body)
    expect(list.agency?.id).toBeTruthy()
    const row = list.projects.find((p) => p.id === TEST_IDS.projectId)
    expect(row.cachedReport?.id).toBe(firstBody.id)
  })

  it('returns 404 for unknown projectId', async () => {
    const token = tokenFor(TEST_IDS.ownerUserId, 'OWNER')
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/activity-reports/generate',
      headers: { authorization: `Bearer ${token}` },
      payload: { month: MONTH, projectId: '00000000-0000-0000-0000-000000000000' },
    })
    expect(res.statusCode).toBe(404)
  })
})

// ── Fetch + export ──
describe('GET /api/admin/activity-reports/:id + /:id/export', () => {
  it('fetches a stored report and exports it as markdown', async () => {
    const token = tokenFor(TEST_IDS.ownerUserId, 'OWNER')
    const stored = await prisma.projectActivityReport.findFirst({ where: { month: MONTH, scope: 'AGENCY' } })
    expect(stored).toBeTruthy()

    const fetchRes = await app.inject({
      method: 'GET',
      url: `/api/admin/activity-reports/${stored.id}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(fetchRes.statusCode).toBe(200)
    const fetched = JSON.parse(fetchRes.body)
    expect(fetched.id).toBe(stored.id)

    const exportRes = await app.inject({
      method: 'GET',
      url: `/api/admin/activity-reports/${stored.id}/export?format=md`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(exportRes.statusCode).toBe(200)
    expect(exportRes.headers['content-type']).toMatch(/text\/markdown/)
    expect(exportRes.headers['content-disposition']).toMatch(/attachment/)
    expect(exportRes.body.length).toBeGreaterThan(0)
  })

  it('returns 404 for unknown report id', async () => {
    const token = tokenFor(TEST_IDS.ownerUserId, 'OWNER')
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/activity-reports/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('rejects unsupported export formats', async () => {
    const token = tokenFor(TEST_IDS.ownerUserId, 'OWNER')
    const stored = await prisma.projectActivityReport.findFirst({ where: { month: MONTH, scope: 'AGENCY' } })
    const res = await app.inject({
      method: 'GET',
      url: `/api/admin/activity-reports/${stored.id}/export?format=pdf`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })
})
