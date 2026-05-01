import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock prisma BEFORE importing the module under test so the import picks up
// the mocked client.
vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: {
    clientUser: {
      findMany: vi.fn(),
    },
  },
}))

import { requireClient } from '../../../src/lib/requireClient.js'
import { prisma } from '../../../src/lib/prisma.js'

function makeMockReply() {
  const reply = {
    status: vi.fn(),
    send: vi.fn(),
  }
  reply.status.mockReturnValue(reply)
  return reply
}

const CLIENT_ROW = (clientId, role = 'MANAGER') => ({
  clientId,
  role,
  isPrimaryContact: false,
  canApproveDeliverables: true,
})

describe('requireClient', () => {
  let mockReply

  beforeEach(() => {
    vi.clearAllMocks()
    mockReply = makeMockReply()
  })

  it('rejects PM / TEAM_MEMBER / CONTRACTOR roles with 403', async () => {
    for (const role of ['PM', 'TEAM_MEMBER', 'CONTRACTOR']) {
      const reply = makeMockReply()
      await requireClient({ user: { id: 'u1', role } }, reply)
      expect(reply.status).toHaveBeenCalledWith(403)
      expect(reply.send).toHaveBeenCalledWith({ message: 'Client access required' })
    }
  })

  it('rejects unauthenticated requests with 403', async () => {
    await requireClient({}, mockReply)
    expect(mockReply.status).toHaveBeenCalledWith(403)
    expect(mockReply.send).toHaveBeenCalledWith({ message: 'Client access required' })
  })

  it('allows a CLIENT user with at least one ClientUser row', async () => {
    prisma.clientUser.findMany.mockResolvedValue([CLIENT_ROW('c1')])
    const request = { user: { id: 'u1', role: 'CLIENT' }, headers: {} }

    await requireClient(request, mockReply)

    expect(mockReply.status).not.toHaveBeenCalled()
    expect(request.clientAccountIds).toEqual(['c1'])
    expect(request.clientUserRoles).toHaveLength(1)
    expect(request.actingAsClient).toBe(false)
  })

  it('returns 403 when a CLIENT has no ClientUser rows', async () => {
    prisma.clientUser.findMany.mockResolvedValue([])
    await requireClient({ user: { id: 'u1', role: 'CLIENT' }, headers: {} }, mockReply)
    expect(mockReply.status).toHaveBeenCalledWith(403)
    expect(mockReply.send).toHaveBeenCalledWith({ message: 'No client account linked' })
  })

  it('allows an OWNER linked via ClientUser (no scope header => all clients)', async () => {
    prisma.clientUser.findMany.mockResolvedValue([
      CLIENT_ROW('c1'),
      CLIENT_ROW('c2'),
    ])
    const request = { user: { id: 'owner', role: 'OWNER' }, headers: {} }

    await requireClient(request, mockReply)

    expect(mockReply.status).not.toHaveBeenCalled()
    expect(request.clientAccountIds).toEqual(['c1', 'c2'])
    // no header => actingAsClient stays false even for OWNER
    expect(request.actingAsClient).toBe(false)
  })

  it('returns 403 when an OWNER has no ClientUser rows', async () => {
    prisma.clientUser.findMany.mockResolvedValue([])
    await requireClient({ user: { id: 'owner', role: 'OWNER' }, headers: {} }, mockReply)
    expect(mockReply.status).toHaveBeenCalledWith(403)
    expect(mockReply.send).toHaveBeenCalledWith({ message: 'No client account linked' })
  })

  it('narrows scope when OWNER sends an X-Client-Id header matching one of their links', async () => {
    prisma.clientUser.findMany.mockResolvedValue([
      CLIENT_ROW('c1'),
      CLIENT_ROW('c2'),
    ])
    const request = {
      user: { id: 'owner', role: 'OWNER' },
      headers: { 'x-client-id': 'c2' },
    }

    await requireClient(request, mockReply)

    expect(mockReply.status).not.toHaveBeenCalled()
    expect(request.clientAccountIds).toEqual(['c2'])
    expect(request.clientUserRoles).toHaveLength(1)
    expect(request.actingAsClient).toBe(true)
  })

  it('rejects with 403 when X-Client-Id does not match any linked client', async () => {
    prisma.clientUser.findMany.mockResolvedValue([CLIENT_ROW('c1')])
    const request = {
      user: { id: 'owner', role: 'OWNER' },
      headers: { 'x-client-id': 'c-not-linked' },
    }

    await requireClient(request, mockReply)

    expect(mockReply.status).toHaveBeenCalledWith(403)
    expect(mockReply.send).toHaveBeenCalledWith({ message: 'Client scope not permitted' })
  })

  it('does NOT set actingAsClient=true for a native CLIENT user even when sending X-Client-Id', async () => {
    prisma.clientUser.findMany.mockResolvedValue([
      CLIENT_ROW('c1'),
      CLIENT_ROW('c2'),
    ])
    const request = {
      user: { id: 'client-u', role: 'CLIENT' },
      headers: { 'x-client-id': 'c1' },
    }

    await requireClient(request, mockReply)

    expect(mockReply.status).not.toHaveBeenCalled()
    expect(request.clientAccountIds).toEqual(['c1'])
    // actingAsClient is only true for OWNER-switcher mode.
    expect(request.actingAsClient).toBe(false)
  })
})
