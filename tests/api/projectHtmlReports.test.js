import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../setup/test-app.js'
import { seedTestDb, truncateAllTables, connectTestDb, disconnectTestDb, prisma } from '../setup/db.js'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_ACCESS_SECRET || 'test-jwt-secret-32-chars-minimum!!'

const TEST_IDS = {
  ownerUserId: '11111111-1111-1111-1111-111111111111',
  pmUserId: '22222222-2222-2222-2222-222222222222',
  clientUserId: '55555555-5555-5555-5555-555555555555',
  otherClientUserId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  projectId: '88888888-8888-8888-8888-888888888888',
  otherProjectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  clientId: '77777777-7777-7777-7777-777777777777',
  otherClientId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  packageId: '66666666-6666-6666-6666-666666666666',
}

const MONTH = '2026-06'
const HTML_CONTENT = '<!DOCTYPE html><html><body><h1>June Report</h1></body></html>'

function tokenFor(userId, role) {
  return jwt.sign({ sub: userId, role }, JWT_SECRET, { expiresIn: '15m' })
}

function buildMultipartBody({ projectId, month, fileName, content, mimetype = 'text/html' }) {
  const boundary = '----LocalwavesTestBoundary'
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="projectId"\r\n\r\n${projectId}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="month"\r\n\r\n${month}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimetype}\r\n\r\n`,
    `\r\n--${boundary}--\r\n`,
  ]
  const prefix = Buffer.from(parts[0] + parts[1] + parts[2], 'utf8')
  const fileBuf = Buffer.from(content, 'utf8')
  const suffix = Buffer.from(parts[3], 'utf8')
  return {
    body: Buffer.concat([prefix, fileBuf, suffix]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

async function uploadAdminReport(app, { projectId = TEST_IDS.projectId, month = MONTH, fileName = 'report.html', content = HTML_CONTENT, mimetype } = {}) {
  const token = tokenFor(TEST_IDS.ownerUserId, 'OWNER')
  const { body, contentType } = buildMultipartBody({ projectId, month, fileName, content, mimetype })
  return app.inject({
    method: 'POST',
    url: '/api/admin/project-html-reports',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': contentType,
    },
    payload: body,
  })
}

let app

beforeAll(async () => {
  await connectTestDb()
  await truncateAllTables()
  await seedTestDb()

  await prisma.user.create({
    data: {
      id: TEST_IDS.otherClientUserId,
      email: 'otherclient@test.com',
      passwordHash: '$2b$10$i1BYwmxM401VdOEv8UdssOYHXISRzV6fW4Z1OaRYm3/Srt7Qumm3O',
      role: 'CLIENT',
      name: 'Other Client',
      isActive: true,
    },
  })
  await prisma.clientAccount.create({
    data: {
      id: TEST_IDS.otherClientId,
      packageId: TEST_IDS.packageId,
      agencyName: 'Other Agency',
      leadPmId: TEST_IDS.pmUserId,
      onboardingStatus: 'PENDING',
      onboardingStep: 1,
      isActive: true,
    },
  })
  await prisma.clientUser.create({
    data: {
      id: 'cu-other-11111111-1111-1111-1111-111111111111',
      clientId: TEST_IDS.otherClientId,
      userId: TEST_IDS.otherClientUserId,
      addedById: TEST_IDS.ownerUserId,
    },
  })
  await prisma.project.create({
    data: {
      id: TEST_IDS.otherProjectId,
      clientId: TEST_IDS.otherClientId,
      name: 'Other Project',
      projectType: 'SEO_CAMPAIGN',
      status: 'ACTIVE',
      onboardingStep: 1,
      leadPmId: TEST_IDS.pmUserId,
    },
  })

  app = await buildApp()
})

afterAll(async () => {
  await truncateAllTables()
  await app.close()
  await disconnectTestDb()
})

describe('Project HTML reports: upload validation', () => {
  it('rejects non-HTML files', async () => {
    const res = await uploadAdminReport(app, {
      fileName: 'report.pdf',
      content: '%PDF-1.4 fake',
      mimetype: 'application/pdf',
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toMatch(/\.html|\.htm/i)
  })

  it('accepts HTML upload and returns DELIVERED status', async () => {
    const res = await uploadAdminReport(app)
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.id).toBeTruthy()
    expect(body.projectId).toBe(TEST_IDS.projectId)
    expect(body.month).toBe(MONTH)
    expect(body.status).toBe('DELIVERED')
    expect(body.fileName).toBe('report.html')
  })

  it('upserts on re-upload for same project and month', async () => {
    const first = await uploadAdminReport(app)
    const firstBody = JSON.parse(first.body)
    const res = await uploadAdminReport(app, {
      fileName: 'updated.html',
      content: '<html><body>Updated</body></html>',
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.id).toBe(firstBody.id)
    expect(body.fileName).toBe('updated.html')

    const count = await prisma.projectHtmlReport.count({
      where: { projectId: TEST_IDS.projectId, month: MONTH },
    })
    expect(count).toBe(1)
  })
})

describe('Project HTML reports: client access', () => {
  let seededReportId
  let otherReportId

  beforeAll(async () => {
    const seeded = await uploadAdminReport(app, { month: '2026-05' })
    seededReportId = JSON.parse(seeded.body).id

    const other = await uploadAdminReport(app, {
      projectId: TEST_IDS.otherProjectId,
      month: '2026-05',
      fileName: 'other.html',
      content: '<html><body>Other</body></html>',
    })
    otherReportId = JSON.parse(other.body).id
  })

  it('lists only reports for the client own projects', async () => {
    const token = tokenFor(TEST_IDS.clientUserId, 'CLIENT')
    const res = await app.inject({
      method: 'GET',
      url: '/api/client/html-reports',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(Array.isArray(body)).toBe(true)
    const ids = body.map((r) => r.id)
    expect(ids).toContain(seededReportId)
    expect(ids).not.toContain(otherReportId)
    for (const item of body) {
      expect(item.projectId).toBe(TEST_IDS.projectId)
    }
  })

  it('allows client to view own report with CSP header', async () => {
    const token = tokenFor(TEST_IDS.clientUserId, 'CLIENT')
    const res = await app.inject({
      method: 'GET',
      url: `/api/client/html-reports/${seededReportId}/view`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.headers['content-security-policy']).toMatch(/script-src 'none'/)
    expect(res.body).toContain('<html>')
  })

  it('denies client access to another client report', async () => {
    const token = tokenFor(TEST_IDS.clientUserId, 'CLIENT')
    const res = await app.inject({
      method: 'GET',
      url: `/api/client/html-reports/${otherReportId}/view`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('allows client to download own report', async () => {
    const token = tokenFor(TEST_IDS.clientUserId, 'CLIENT')
    const res = await app.inject({
      method: 'GET',
      url: `/api/client/html-reports/${seededReportId}/download`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toMatch(/attachment/)
    expect(res.body).toContain('<html>')
  })
})

describe('Project HTML reports: PM upload', () => {
  it('allows PM to upload for assigned project', async () => {
    const token = tokenFor(TEST_IDS.pmUserId, 'PM')
    const { body, contentType } = buildMultipartBody({
      projectId: TEST_IDS.projectId,
      month: '2026-07',
      fileName: 'pm-report.html',
      content: '<html><body>PM upload</body></html>',
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/pm/project-html-reports',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': contentType,
      },
      payload: body,
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).status).toBe('DELIVERED')
  })

  it('denies PM upload for unassigned project', async () => {
    const token = tokenFor(TEST_IDS.pmUserId, 'PM')
    await prisma.project.update({
      where: { id: TEST_IDS.otherProjectId },
      data: { leadPmId: TEST_IDS.ownerUserId },
    })
    await prisma.clientAccount.update({
      where: { id: TEST_IDS.otherClientId },
      data: { leadPmId: TEST_IDS.ownerUserId, secondaryPmId: null },
    })

    const { body, contentType } = buildMultipartBody({
      projectId: TEST_IDS.otherProjectId,
      month: '2026-08',
      fileName: 'denied.html',
      content: '<html><body>Nope</body></html>',
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/pm/project-html-reports',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': contentType,
      },
      payload: body,
    })
    expect(res.statusCode).toBe(403)
  })
})
