/**
 * Integration tests for the public interview link, admin scheduler and PM
 * review additions (plan §14, §24). Needs the MySQL test DB from .env.test.
 * OpenAI Realtime, Anthropic and SMTP are mocked — nothing external is called.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import jwt from 'jsonwebtoken'

vi.mock('../../src/lib/realtimeVoice.js', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    isRealtimeVoiceConfigured: () => true,
    mintRealtimeSession: vi.fn(async () => ({ clientSecret: 'ek_test', expiresAt: null, model: 'gpt-realtime', voice: 'marin' })),
  }
})
vi.mock('../../src/lib/mailer.js', () => ({
  sendEmail: vi.fn(async () => ({ success: true, messageId: 'test' })),
  smtpConfigured: false,
}))
vi.mock('../../src/lib/ai.js', async (orig) => ({
  ...(await orig()),
  isAiConfigured: () => true,
  generateChat: vi.fn(async () => ({
    parsed: {
      reply: 'Thanks! What time do you open on Saturdays?',
      actions: [{ tool: 'save_business_fact', args: { folder: 'company', filename: 'hours', title: 'Weekday hours', content: 'Mon–Fri 8am–6pm', fact_type: 'hours', source_quote: 'eight to six' } }],
      finished: false,
    },
  })),
}))

import { buildApp } from '../setup/test-app.js'
import { seedTestDb, truncateAllTables, connectTestDb, disconnectTestDb, prisma } from '../setup/db.js'
import { mintToken, placeholderHash } from '../../src/lib/interviewInvites.js'
import { sendEmail } from '../../src/lib/mailer.js'

const JWT_SECRET = process.env.JWT_ACCESS_SECRET || 'test-jwt-secret-32-chars-minimum!!'
const IDS = {
  owner: '11111111-1111-1111-1111-111111111111',
  pm: '22222222-2222-2222-2222-222222222222',
  client: '77777777-7777-7777-7777-777777777777',
}
const auth = (id, role) => ({ authorization: `Bearer ${jwt.sign({ sub: id, role }, JWT_SECRET, { expiresIn: '15m' })}` })

let app

async function makeInvite(overrides = {}) {
  const id = overrides.id || crypto.randomUUID()
  const t = mintToken(id)
  await prisma.knowledgeInterviewInvite.create({
    data: {
      id,
      clientId: IDS.client,
      tokenHash: t.tokenHash,
      tokenNonce: t.nonce,
      createdById: IDS.owner,
      recipientName: 'Hina',
      sentToEmail: 'hina@client.com',
      status: 'SENT',
      expiresAt: new Date(Date.now() + 7 * 864e5),
      rootInviteId: id,
      agenda: {
        version: 1,
        goals: ['Catch up'],
        questions: [
          { id: 'company-hours', folder: 'company', factType: 'hours', prompt: 'Hours?', topic: 'Hours', kind: 'primary' },
          { id: 'services-prices', folder: 'services', factType: 'price', prompt: 'Prices?', topic: 'Prices', kind: 'primary' },
        ],
        doNotAsk: [],
        gaps: [],
      },
      ...overrides,
    },
  })
  return { id, token: t.token }
}

const post = (url, payload) => app.inject({ method: 'POST', url, payload: payload ?? {} })

beforeAll(async () => {
  process.env.INTERVIEW_TOKEN_SECRET = 'integration-interview-secret-0123456789'
  await connectTestDb()
  await truncateAllTables()
  await seedTestDb()
  app = await buildApp()
})

afterAll(async () => {
  await truncateAllTables()
  await app?.close()
  await disconnectTestDb()
})

beforeEach(() => vi.clearAllMocks())

describe('token resolution', () => {
  it('404 for unknown tokens; a SCHEDULED invite is unreachable even by its derived token', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/public/knowledge-interview/' + 'x'.repeat(43) })).statusCode).toBe(404)
    const scheduled = await makeInvite({ status: 'SCHEDULED' })
    expect((await app.inject({ method: 'GET', url: `/api/public/knowledge-interview/${scheduled.token}` })).statusCode).toBe(404)
    expect(placeholderHash()).toHaveLength(64)
  })

  it('410 for revoked and expired invites', async () => {
    const revoked = await makeInvite({ status: 'REVOKED' })
    expect((await app.inject({ method: 'GET', url: `/api/public/knowledge-interview/${revoked.token}` })).statusCode).toBe(410)
    const expired = await makeInvite({ expiresAt: new Date(Date.now() - 1000) })
    expect((await app.inject({ method: 'GET', url: `/api/public/knowledge-interview/${expired.token}` })).statusCode).toBe(410)
  })

  it('GET returns the v2 context and marks OPENED', async () => {
    const { id, token } = await makeInvite()
    const res = await app.inject({ method: 'GET', url: `/api/public/knowledge-interview/${token}` })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.version).toBe(2)
    expect(body.mode).toBe('interview')
    expect(body.agenda.topics.map((t) => t.id)).toEqual(['company-hours', 'services-prices'])
    expect(body.consent.given).toBe(false)
    expect(body.canDelegate).toBe(true)
    expect(JSON.stringify(body)).not.toContain('tokenHash')
    expect((await prisma.knowledgeInterviewInvite.findUnique({ where: { id } })).status).toBe('OPENED')
  })
})

describe('consent gate + voice session', () => {
  it('refuses a session before consent', async () => {
    const { token } = await makeInvite()
    const res = await post(`/api/public/knowledge-interview/${token}/voice/session`)
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).code).toBe('CONSENT_REQUIRED')
  })

  it('mints after consent, attributes the session to the invite creator, and files captures', async () => {
    const { id, token } = await makeInvite()
    expect((await post(`/api/public/knowledge-interview/${token}/consent`, { accepted: true })).statusCode).toBe(200)
    const res = await post(`/api/public/knowledge-interview/${token}/voice/session`)
    expect(res.statusCode).toBe(200)
    const { sessionId, clientSecret, maxSessionSeconds } = JSON.parse(res.body)
    expect(clientSecret).toBe('ek_test')
    expect(maxSessionSeconds).toBeGreaterThan(0)
    const session = await prisma.voiceInterviewSession.findUnique({ where: { id: sessionId } })
    expect(session.userId).toBe(IDS.owner)
    expect(session.inviteId).toBe(id)

    const cap = await post(`/api/public/knowledge-interview/${token}/voice/${sessionId}/capture`, {
      calls: [{
        callId: 'c1',
        tool: 'save_business_fact',
        args: { folder: 'company', filename: 'hours', title: 'Hours', content: 'Mon–Fri 8–6', source_quote: 'eight till six', agenda_question_id: 'company-hours' },
        transcriptRef: { turnIndex: 3 },
      }],
    })
    expect(cap.statusCode).toBe(200)
    const ack = JSON.parse(cap.body).results[0].ack
    const draft = await prisma.okfDraftChange.findUnique({ where: { id: ack.draftId } })
    expect(draft).toMatchObject({ inviteId: id, rootInviteId: id, respondentRole: 'CLIENT', respondentName: 'Hina', sourceType: 'INTERVIEW_LINK', sourceQuote: 'eight till six' })

    const done = await post(`/api/public/knowledge-interview/${token}/voice/${sessionId}/complete`, { durationSeconds: 5 })
    expect(done.statusCode).toBe(200)
    const after = await prisma.voiceInterviewSession.findUnique({ where: { id: sessionId } })
    expect(after.status).toBe('COMPLETED')
    expect(after.consolidationStatus).toBe('PENDING')
  })

  it('429 when the invite minute budget is used up', async () => {
    const { token } = await makeInvite({ consentAt: new Date(), minutesBudget: 1, totalVoiceSeconds: 60 })
    const res = await post(`/api/public/knowledge-interview/${token}/voice/session`)
    expect(res.statusCode).toBe(429)
    expect(JSON.parse(res.body).code).toBe('INVITE_MINUTES_USED')
  })

  it('429 when the client monthly cap (admin setting, D5) is used up', async () => {
    await prisma.interviewSetting.upsert({
      where: { scope: IDS.client },
      create: { scope: IDS.client, clientId: IDS.client, monthlyMinutesPerClient: 0 },
      update: { monthlyMinutesPerClient: 0 },
    })
    const { token } = await makeInvite({ consentAt: new Date() })
    const res = await post(`/api/public/knowledge-interview/${token}/voice/session`)
    expect(res.statusCode).toBe(429)
    expect(JSON.parse(res.body).code).toBe('VOICE_MONTHLY_LIMIT')
    await prisma.interviewSetting.deleteMany({ where: { scope: IDS.client } })
  })

  it('429 after the per-invite session cap', async () => {
    const { token } = await makeInvite({ consentAt: new Date(), sessionCount: 8 })
    const res = await post(`/api/public/knowledge-interview/${token}/voice/session`)
    expect(JSON.parse(res.body).code).toBe('INVITE_SESSION_LIMIT')
  })
})

describe('text mode (D10) uses the same capture pipeline', () => {
  it('files a draft from a text turn', async () => {
    const { id, token } = await makeInvite({ consentAt: new Date() })
    const start = await post(`/api/public/knowledge-interview/${token}/text/start`)
    expect(start.statusCode).toBe(200)
    expect(JSON.parse(start.body).messages[0].role).toBe('assistant')
    const turn = await post(`/api/public/knowledge-interview/${token}/text/turn`, { message: 'We open eight to six' })
    expect(turn.statusCode).toBe(200)
    const body = JSON.parse(turn.body)
    expect(body.acks[0].kind).toBe('capture')
    const drafts = await prisma.okfDraftChange.findMany({ where: { inviteId: id } })
    expect(drafts).toHaveLength(1)
    expect(drafts[0].proposedMetadata.type).toBe('text-capture')
  })
})

describe('captures: correct / retract', () => {
  it('only the owning invite (or its root) may edit; retract rejects', async () => {
    const a = await makeInvite({ consentAt: new Date() })
    const b = await makeInvite({ consentAt: new Date() })
    const draft = await prisma.okfDraftChange.create({
      data: { clientId: IDS.client, folder: 'faq', filename: 'q', title: 'Q', proposedBody: 'Answer', sourceType: 'INTERVIEW_LINK', inviteId: a.id, rootInviteId: a.id },
    })
    expect((await post(`/api/public/knowledge-interview/${b.token}/captures/${draft.id}/retract`)).statusCode).toBe(404)
    const fix = await post(`/api/public/knowledge-interview/${a.token}/captures/${draft.id}/correct`, { content: 'Better answer' })
    expect(fix.statusCode).toBe(200)
    expect((await prisma.okfDraftChange.findUnique({ where: { id: draft.id } })).clientCorrected).toBe(true)
    expect((await post(`/api/public/knowledge-interview/${a.token}/captures/${draft.id}/retract`)).statusCode).toBe(200)
    const after = await prisma.okfDraftChange.findUnique({ where: { id: draft.id } })
    expect(after).toMatchObject({ status: 'REJECTED', reviewNote: 'Withdrawn by respondent' })
  })
})

describe('delegation', () => {
  it('root can delegate from the landing page; email is sent; worker cannot delegate (D1)', async () => {
    const root = await makeInvite()
    const res = await post(`/api/public/knowledge-interview/${root.token}/delegate`, {
      workerName: 'Asif', workerEmail: 'asif@client.com', workerRole: 'workshop manager', reason: 'He knows prices', questionIds: ['services-prices'],
    })
    expect(res.statusCode).toBe(201)
    const { childInviteId } = JSON.parse(res.body)
    expect(sendEmail).toHaveBeenCalled()
    const child = await prisma.knowledgeInterviewInvite.findUnique({ where: { id: childInviteId } })
    expect(child).toMatchObject({ respondentRole: 'STAFF', delegationDepth: 1, parentInviteId: root.id, status: 'SENT' })
    const rootAfter = await prisma.knowledgeInterviewInvite.findUnique({ where: { id: root.id } })
    expect(rootAfter.agenda.questions.find((q) => q.id === 'services-prices').delegatedTo).toBe(childInviteId)

    // The worker's own link
    const { deriveToken } = await import('../../src/lib/interviewInvites.js')
    const workerToken = deriveToken(child.id, child.tokenNonce)
    const ctx = JSON.parse((await app.inject({ method: 'GET', url: `/api/public/knowledge-interview/${workerToken}` })).body)
    expect(ctx.canDelegate).toBe(false)
    expect(ctx.respondent.delegatorName).toBe('Hina')
    const nope = await post(`/api/public/knowledge-interview/${workerToken}/delegate`, { workerName: 'X', workerEmail: 'x@client.com', questionIds: [] })
    expect(nope.statusCode).toBe(403)

    // Decline
    expect((await post(`/api/public/knowledge-interview/${workerToken}/decline`)).statusCode).toBe(200)
    expect((await prisma.knowledgeInterviewInvite.findUnique({ where: { id: child.id } })).status).toBe('DECLINED')
  })

  it('rejects delegating to the root\'s own email', async () => {
    const root = await makeInvite()
    const res = await post(`/api/public/knowledge-interview/${root.token}/delegate`, { workerName: 'Me', workerEmail: 'hina@client.com', questionIds: ['company-hours'] })
    expect(res.statusCode).toBe(400)
  })
})

describe('finish + summary mode', () => {
  it('a COMPLETED root opens in summary mode instead of 410, but cannot mint sessions', async () => {
    const { token } = await makeInvite({ consentAt: new Date() })
    expect((await post(`/api/public/knowledge-interview/${token}/finish`)).statusCode).toBe(200)
    const ctx = await app.inject({ method: 'GET', url: `/api/public/knowledge-interview/${token}` })
    expect(ctx.statusCode).toBe(200)
    expect(JSON.parse(ctx.body).mode).toBe('summary')
    expect((await post(`/api/public/knowledge-interview/${token}/voice/session`)).statusCode).toBe(410)
    expect((await app.inject({ method: 'GET', url: `/api/public/knowledge-interview/${token}/summary` })).statusCode).toBe(200)
  })
})

describe('admin + PM routes', () => {
  it('admin routes are OWNER-only (D8)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/interviews/invites', headers: auth(IDS.pm, 'PM') })
    expect(res.statusCode).toBe(403)
  })

  it('owner creates an invite (link only) and reads settings', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/interviews/invites',
      headers: auth(IDS.owner, 'OWNER'),
      payload: { clientId: IDS.client, templateKey: 'MONTHLY_UPDATE', recipients: [{ name: 'Hina' }], sendEmail: false },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.urls[0].url).toContain('/knowledge-interview/')
    expect(JSON.stringify(body.invites)).not.toContain('tokenHash')
    const settings = await app.inject({ method: 'GET', url: '/api/admin/interviews/settings', headers: auth(IDS.owner, 'OWNER') })
    expect(JSON.parse(settings.body).effectiveAgency.autoApproveLowRisk).toBe(true)
  })

  it('PM queue filters by inviteId and returns a diff', async () => {
    const { id } = await makeInvite()
    const d = await prisma.okfDraftChange.create({
      data: { clientId: IDS.client, folder: 'faq', filename: 'zz-none', title: 'Q', proposedBody: 'Answer', sourceType: 'INTERVIEW_LINK', inviteId: id, rootInviteId: id, riskLevel: 'LOW' },
    })
    const list = await app.inject({ method: 'GET', url: `/api/pm/okf-review/drafts?inviteId=${id}&riskLevel=LOW`, headers: auth(IDS.owner, 'OWNER') })
    expect(JSON.parse(list.body).drafts.map((x) => x.id)).toEqual([d.id])
    const diff = await app.inject({ method: 'GET', url: `/api/pm/okf-review/drafts/${d.id}/diff`, headers: auth(IDS.owner, 'OWNER') })
    expect(JSON.parse(diff.body)).toMatchObject({ current: null, stale: false })
  })
})
