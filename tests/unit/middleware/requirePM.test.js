import { describe, it, expect, vi, beforeEach } from 'vitest'
import { requirePM } from '../../../src/lib/requirePM.js'

function makeMockReply() {
  const reply = {
    status: vi.fn(),
    send: vi.fn()
  }
  reply.status.mockReturnValue(reply)
  return reply
}

describe('requirePM', () => {
  let mockReply

  beforeEach(() => {
    vi.clearAllMocks()
    mockReply = makeMockReply()
  })

  it('allows PM role through without calling reply.status', async () => {
    const request = { user: { role: 'PM' } }

    await requirePM(request, mockReply)

    expect(mockReply.status).not.toHaveBeenCalled()
    expect(mockReply.send).not.toHaveBeenCalled()
  })

  it('allows OWNER role through (OWNER can do PM things)', async () => {
    const request = { user: { role: 'OWNER' } }

    await requirePM(request, mockReply)

    expect(mockReply.status).not.toHaveBeenCalled()
    expect(mockReply.send).not.toHaveBeenCalled()
  })

  it('returns 403 for CLIENT role', async () => {
    const request = { user: { role: 'CLIENT' } }

    await requirePM(request, mockReply)

    expect(mockReply.status).toHaveBeenCalledWith(403)
    expect(mockReply.send).toHaveBeenCalledWith({ message: 'PM or Owner access required' })
  })

  it('returns 403 for TEAM_MEMBER role', async () => {
    const request = { user: { role: 'TEAM_MEMBER' } }

    await requirePM(request, mockReply)

    expect(mockReply.status).toHaveBeenCalledWith(403)
    expect(mockReply.send).toHaveBeenCalledWith({ message: 'PM or Owner access required' })
  })

  it('returns 403 for CONTRACTOR role', async () => {
    const request = { user: { role: 'CONTRACTOR' } }

    await requirePM(request, mockReply)

    expect(mockReply.status).toHaveBeenCalledWith(403)
    expect(mockReply.send).toHaveBeenCalledWith({ message: 'PM or Owner access required' })
  })

  it('returns 403 when user is undefined', async () => {
    const request = {}

    await requirePM(request, mockReply)

    expect(mockReply.status).toHaveBeenCalledWith(403)
    expect(mockReply.send).toHaveBeenCalledWith({ message: 'PM or Owner access required' })
  })
})
