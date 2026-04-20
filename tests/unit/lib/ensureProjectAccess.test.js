import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: {
    clientAccount: { findUnique: vi.fn() },
    task: { count: vi.fn() }
  }
}))

const { prisma } = await import('../../../src/lib/prisma.js')
const { ensureProjectAccess } = await import('../../../src/lib/ensureProjectAccess.js')

describe('ensureProjectAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns false when project is null', async () => {
    const result = await ensureProjectAccess(null, { role: 'OWNER', id: 'u1' })
    expect(result).toBe(false)
  })

  it('returns true for OWNER regardless of project', async () => {
    const project = { id: 'p1', leadPmId: 'other-pm', clientId: 'c1' }
    const user = { id: 'owner-1', role: 'OWNER' }

    const result = await ensureProjectAccess(project, user)

    expect(result).toBe(true)
    expect(prisma.clientAccount.findUnique).not.toHaveBeenCalled()
    expect(prisma.task.count).not.toHaveBeenCalled()
  })

  it('returns true for PM when leadPmId matches user.id', async () => {
    const project = { id: 'p1', leadPmId: 'pm-1', clientId: 'c1' }
    const user = { id: 'pm-1', role: 'PM' }

    const result = await ensureProjectAccess(project, user)

    expect(result).toBe(true)
    expect(prisma.clientAccount.findUnique).not.toHaveBeenCalled()
  })

  it('returns true for PM when secondaryPmId matches user.id', async () => {
    const project = { id: 'p1', leadPmId: 'other-pm', clientId: 'c1' }
    const user = { id: 'pm-2', role: 'PM' }

    prisma.clientAccount.findUnique.mockResolvedValue({ secondaryPmId: 'pm-2' })

    const result = await ensureProjectAccess(project, user)

    expect(result).toBe(true)
    expect(prisma.clientAccount.findUnique).toHaveBeenCalledWith({
      where: { id: 'c1' },
      select: { secondaryPmId: true }
    })
  })

  it('returns false for PM not assigned as lead or secondary', async () => {
    const project = { id: 'p1', leadPmId: 'other-pm', clientId: 'c1' }
    const user = { id: 'pm-unassigned', role: 'PM' }

    prisma.clientAccount.findUnique.mockResolvedValue({ secondaryPmId: 'someone-else' })

    const result = await ensureProjectAccess(project, user)

    expect(result).toBe(false)
  })

  it('returns false for PM when clientAccount is not found', async () => {
    const project = { id: 'p1', leadPmId: 'other-pm', clientId: 'c1' }
    const user = { id: 'pm-3', role: 'PM' }

    prisma.clientAccount.findUnique.mockResolvedValue(null)

    const result = await ensureProjectAccess(project, user)

    expect(result).toBe(false)
  })

  it('returns true for TEAM_MEMBER with inline tasks containing matching assignee', async () => {
    const project = {
      id: 'p1',
      tasks: [
        { assignees: [{ id: 'tm-1' }, { id: 'tm-2' }] },
        { assignees: [{ id: 'tm-3' }] }
      ]
    }
    const user = { id: 'tm-1', role: 'TEAM_MEMBER' }

    const result = await ensureProjectAccess(project, user)

    expect(result).toBe(true)
    expect(prisma.task.count).not.toHaveBeenCalled()
  })

  it('returns false for TEAM_MEMBER with inline tasks but no matching assignee', async () => {
    const project = {
      id: 'p1',
      tasks: [
        { assignees: [{ id: 'tm-other' }] }
      ]
    }
    const user = { id: 'tm-1', role: 'TEAM_MEMBER' }

    const result = await ensureProjectAccess(project, user)

    expect(result).toBe(false)
    expect(prisma.task.count).not.toHaveBeenCalled()
  })

  it('returns true for TEAM_MEMBER via prisma task count when tasks not inline', async () => {
    const project = { id: 'p1' }
    const user = { id: 'tm-1', role: 'TEAM_MEMBER' }

    prisma.task.count.mockResolvedValue(2)

    const result = await ensureProjectAccess(project, user)

    expect(result).toBe(true)
    expect(prisma.task.count).toHaveBeenCalledWith({
      where: { projectId: 'p1', assignees: { some: { id: 'tm-1' } } }
    })
  })

  it('returns false for TEAM_MEMBER with no tasks assigned via prisma', async () => {
    const project = { id: 'p1' }
    const user = { id: 'tm-1', role: 'TEAM_MEMBER' }

    prisma.task.count.mockResolvedValue(0)

    const result = await ensureProjectAccess(project, user)

    expect(result).toBe(false)
  })

  it('returns true for CONTRACTOR with inline tasks containing matching assignee', async () => {
    const project = {
      id: 'p1',
      tasks: [
        { assignees: [{ id: 'ct-1' }] }
      ]
    }
    const user = { id: 'ct-1', role: 'CONTRACTOR' }

    const result = await ensureProjectAccess(project, user)

    expect(result).toBe(true)
  })

  it('returns true for CONTRACTOR via prisma task count', async () => {
    const project = { id: 'p1' }
    const user = { id: 'ct-1', role: 'CONTRACTOR' }

    prisma.task.count.mockResolvedValue(1)

    const result = await ensureProjectAccess(project, user)

    expect(result).toBe(true)
  })

  it('returns false for CLIENT role', async () => {
    const project = { id: 'p1' }
    const user = { id: 'client-1', role: 'CLIENT' }

    const result = await ensureProjectAccess(project, user)

    expect(result).toBe(false)
  })

  it('returns false for unknown role', async () => {
    const project = { id: 'p1' }
    const user = { id: 'u1', role: 'UNKNOWN' }

    const result = await ensureProjectAccess(project, user)

    expect(result).toBe(false)
  })
})
