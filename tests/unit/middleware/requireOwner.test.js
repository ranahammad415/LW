import { describe, it, expect, vi, beforeEach } from 'vitest'
import { requireOwner } from '../../../src/lib/requireOwner.js'

function makeMockReply() {
  const reply = {
    status: vi.fn(),
    send: vi.fn()
  }
  reply.status.mockReturnValue(reply)
  return reply
}

describe('requireOwner', () => {
  let mockReply

  beforeEach(() => {
    vi.clearAllMocks()
    mockReply = makeMockReply()
  })

  it('allows OWNER role through without calling reply.status', async () => {
    const request = { user: { role: 'OWNER' } }

    await requireOwner(request, mockReply)

    expect(mockReply.status).not.toHaveBeenCalled()
    expect(mockReply.send).not.toHaveBeenCalled()
  })

  it('returns 403 for PM role', async () => {
    const request = { user: { role: 'PM' } }

    await requireOwner(request, mockReply)

    expect(mockReply.status).toHaveBeenCalledWith(403)
    expect(mockReply.send).toHaveBeenCalledWith({ message: 'Admin access required' })
  })

  it('returns 403 for CLIENT role', async () => {
    const request = { user: { role: 'CLIENT' } }

    await requireOwner(request, mockReply)

    expect(mockReply.status).toHaveBeenCalledWith(403)
    expect(mockReply.send).toHaveBeenCalledWith({ message: 'Admin access required' })
  })

  it('returns 403 for TEAM_MEMBER role', async () => {
    const request = { user: { role: 'TEAM_MEMBER' } }

    await requireOwner(request, mockReply)

    expect(mockReply.status).toHaveBeenCalledWith(403)
    expect(mockReply.send).toHaveBeenCalledWith({ message: 'Admin access required' })
  })

  it('returns 403 when user is undefined', async () => {
    const request = {}

    await requireOwner(request, mockReply)

    expect(mockReply.status).toHaveBeenCalledWith(403)
    expect(mockReply.send).toHaveBeenCalledWith({ message: 'Admin access required' })
  })
})
