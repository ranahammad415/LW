import { describe, it, expect, vi, beforeEach } from 'vitest'

// Set env var BEFORE any imports so verifyJwt module-level check passes
process.env.JWT_ACCESS_SECRET = 'test-jwt-secret-32-chars-minimum!!'

vi.mock('jsonwebtoken', () => ({
  default: { verify: vi.fn() }
}))

vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() }
  }
}))

const jwt = (await import('jsonwebtoken')).default
const { prisma } = await import('../../../src/lib/prisma.js')
const { verifyJwt } = await import('../../../src/lib/verifyJwt.js')

function makeMockReply() {
  const reply = {
    status: vi.fn(),
    send: vi.fn()
  }
  reply.status.mockReturnValue(reply)
  return reply
}

describe('verifyJwt', () => {
  let mockRequest
  let mockReply

  beforeEach(() => {
    vi.clearAllMocks()
    mockRequest = {
      headers: { authorization: 'Bearer valid-token' }
    }
    mockReply = makeMockReply()
  })

  it('sets request.user when JWT is valid and user is active', async () => {
    const userPayload = { sub: 'user-id-123', role: 'OWNER' }
    const dbUser = {
      id: 'user-id-123',
      email: 'owner@test.com',
      role: 'OWNER',
      name: 'Test Owner',
      avatarUrl: null,
      phone: null,
      timezone: 'UTC',
      isActive: true
    }

    jwt.verify.mockReturnValue(userPayload)
    prisma.user.findUnique.mockResolvedValue(dbUser)

    await verifyJwt(mockRequest, mockReply)

    expect(jwt.verify).toHaveBeenCalledWith('valid-token', 'test-jwt-secret-32-chars-minimum!!')
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-id-123' },
      select: {
        id: true,
        email: true,
        role: true,
        name: true,
        avatarUrl: true,
        phone: true,
        timezone: true,
        isActive: true
      }
    })
    expect(mockRequest.user).toEqual(dbUser)
    expect(mockReply.status).not.toHaveBeenCalled()
  })

  it('returns 401 when Authorization header is missing', async () => {
    mockRequest.headers.authorization = undefined

    await verifyJwt(mockRequest, mockReply)

    expect(mockReply.status).toHaveBeenCalledWith(401)
    expect(mockReply.send).toHaveBeenCalledWith({
      message: 'Missing or invalid authorization token'
    })
  })

  it('returns 401 when Authorization header has no Bearer prefix', async () => {
    mockRequest.headers.authorization = 'Basic some-token'

    await verifyJwt(mockRequest, mockReply)

    expect(mockReply.status).toHaveBeenCalledWith(401)
    expect(mockReply.send).toHaveBeenCalledWith({
      message: 'Missing or invalid authorization token'
    })
  })

  it('returns 401 when token is expired', async () => {
    jwt.verify.mockImplementation(() => {
      const err = new Error('jwt expired')
      err.name = 'TokenExpiredError'
      throw err
    })

    await verifyJwt(mockRequest, mockReply)

    expect(mockReply.status).toHaveBeenCalledWith(401)
    expect(mockReply.send).toHaveBeenCalledWith({
      message: 'Access token expired'
    })
  })

  it('returns 401 when user is inactive', async () => {
    jwt.verify.mockReturnValue({ sub: 'user-id-123' })
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-id-123',
      email: 'inactive@test.com',
      role: 'CLIENT',
      name: 'Inactive User',
      avatarUrl: null,
      phone: null,
      timezone: null,
      isActive: false
    })

    await verifyJwt(mockRequest, mockReply)

    expect(mockReply.status).toHaveBeenCalledWith(401)
    expect(mockReply.send).toHaveBeenCalledWith({
      message: 'User not found or inactive'
    })
  })

  it('returns 401 when user is not found in database', async () => {
    jwt.verify.mockReturnValue({ sub: 'nonexistent-id' })
    prisma.user.findUnique.mockResolvedValue(null)

    await verifyJwt(mockRequest, mockReply)

    expect(mockReply.status).toHaveBeenCalledWith(401)
    expect(mockReply.send).toHaveBeenCalledWith({
      message: 'User not found or inactive'
    })
  })

  it('returns 401 when token is malformed', async () => {
    jwt.verify.mockImplementation(() => {
      throw new Error('jwt malformed')
    })

    await verifyJwt(mockRequest, mockReply)

    expect(mockReply.status).toHaveBeenCalledWith(401)
    expect(mockReply.send).toHaveBeenCalledWith({
      message: 'Invalid token'
    })
  })
})
