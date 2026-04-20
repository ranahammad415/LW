import { describe, it, expect, vi, beforeEach } from 'vitest'
import { requireClient } from '../../../src/lib/requireClient.js'

function makeMockReply() {
  const reply = {
    status: vi.fn(),
    send: vi.fn()
  }
  reply.status.mockReturnValue(reply)
  return reply
}

describe('requireClient', () => {
  let mockReply

  beforeEach(() => {
    vi.clearAllMocks()
    mockReply = makeMockReply()
  })

  it('allows CLIENT role through without calling reply.status', async () => {
    const request = { user: { role: 'CLIENT' } }

    await requireClient(request, mockReply)

    expect(mockReply.status).not.toHaveBeenCalled()
    expect(mockReply.send).not.toHaveBeenCalled()
  })

  it('returns 403 for OWNER role', async () => {
    const request = { user: { role: 'OWNER' } }

    await requireClient(request, mockReply)

    expect(mockReply.status).toHaveBeenCalledWith(403)
    expect(mockReply.send).toHaveBeenCalledWith({ message: 'Client access required' })
  })

  it('returns 403 for PM role', async () => {
    const request = { user: { role: 'PM' } }

    await requireClient(request, mockReply)

    expect(mockReply.status).toHaveBeenCalledWith(403)
    expect(mockReply.send).toHaveBeenCalledWith({ message: 'Client access required' })
  })

  it('returns 403 for TEAM_MEMBER role', async () => {
    const request = { user: { role: 'TEAM_MEMBER' } }

    await requireClient(request, mockReply)

    expect(mockReply.status).toHaveBeenCalledWith(403)
    expect(mockReply.send).toHaveBeenCalledWith({ message: 'Client access required' })
  })

  it('returns 403 when user is undefined', async () => {
    const request = {}

    await requireClient(request, mockReply)

    expect(mockReply.status).toHaveBeenCalledWith(403)
    expect(mockReply.send).toHaveBeenCalledWith({ message: 'Client access required' })
  })
})
