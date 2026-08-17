import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { buildApp } from '../setup/test-app.js'
import { seedTestDb, truncateAllTables, connectTestDb, disconnectTestDb, prisma } from '../setup/db.js'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_ACCESS_SECRET || 'test-jwt-secret-32-chars-minimum!!'

const IDS = {
  ownerUserId: '11111111-1111-1111-1111-111111111111',
  clientUserId: '55555555-5555-5555-5555-555555555555',
  clientAccountId: '77777777-7777-7777-7777-777777777777',
  projectId: '88888888-8888-8888-8888-888888888888',
  // A second tenant, created here, used to prove isolation.
  rivalUserId: 'b0000000-0000-0000-0000-000000000001',
  rivalClientId: 'b0000000-0000-0000-0000-000000000002',
  rivalProjectId: 'b0000000-0000-0000-0000-000000000003',
  rivalPageId: 'b0000000-0000-0000-0000-000000000004',
  ownPageId: 'a0000000-0000-0000-0000-000000000001',
}

function token(userId, role) {
  return jwt.sign({ sub: userId, role }, JWT_SECRET, { expiresIn: '15m' })
}

const asOwner = () => ({ authorization: `Bearer ${token(IDS.ownerUserId, 'OWNER')}` })
const asClient = () => ({ authorization: `Bearer ${token(IDS.clientUserId, 'CLIENT')}` })
const asRival = () => ({ authorization: `Bearer ${token(IDS.rivalUserId, 'CLIENT')}` })

let app

/** Builds the second tenant plus one published page for each client. */
async function seedTenants() {
  await prisma.user.create({
    data: {
      id: IDS.rivalUserId,
      email: 'rival@test.com',
      passwordHash: 'x',
      role: 'CLIENT',
      name: 'Rival Client',
    },
  })
  await prisma.clientAccount.create({
    data: {
      id: IDS.rivalClientId,
      agencyName: 'Rival Agency',
      websiteUrl: 'https://rival.com',
    },
  })
  await prisma.clientUser.create({
    data: {
      id: 'b0000000-0000-0000-0000-00000000000a',
      clientId: IDS.rivalClientId,
      userId: IDS.rivalUserId,
      role: 'MANAGER',
    },
  })
  await prisma.project.create({
    data: {
      id: IDS.rivalProjectId,
      clientId: IDS.rivalClientId,
      name: 'Rival Campaign',
      projectType: 'SEO_CAMPAIGN',
      status: 'ACTIVE',
      wpUrl: 'https://rival.com',
    },
  })
  await prisma.wpPage.create({
    data: {
      id: IDS.rivalPageId,
      projectId: IDS.rivalProjectId,
      wpPostId: 901,
      title: 'Rival Services',
      url: 'https://rival.com/services',
      slug: 'services',
      postType: 'page',
      status: 'publish',
      content: '',
      contentHash: 'rival-hash',
    },
  })
  await prisma.wpPage.create({
    data: {
      id: IDS.ownPageId,
      projectId: IDS.projectId,
      wpPostId: 902,
      title: 'Our Services',
      url: 'https://testagency.com/services',
      slug: 'services',
      postType: 'page',
      status: 'publish',
      content: '',
      contentHash: 'own-hash',
    },
  })
  await prisma.project.update({
    where: { id: IDS.projectId },
    data: { wpUrl: 'https://testagency.com' },
  })
}

async function seedCatalog() {
  await prisma.backlinkSite.createMany({
    data: [
      {
        id: 'c0000000-0000-0000-0000-000000000001',
        domain: 'highda.com',
        url: 'https://highda.com/',
        da: 70,
        dr: 65,
        monthlyTraffic: 250000,
        priceUsd: 40,
        valueScore: 20,
        dofollowLinks: 2,
        placementType: 'GUEST_POST',
        isActive: true,
        internalNotes: 'SECRET-SUPPLIER-NOTE',
      },
      {
        id: 'c0000000-0000-0000-0000-000000000002',
        domain: 'cheap.com',
        url: 'https://cheap.com/',
        da: 30,
        dr: 35,
        monthlyTraffic: 5000,
        priceUsd: 5,
        valueScore: 90,
        dofollowLinks: 1,
        placementType: 'PROFILE',
        isActive: true,
        internalNotes: 'SECRET-SUPPLIER-NOTE',
      },
      {
        id: 'c0000000-0000-0000-0000-000000000003',
        domain: 'retired.com',
        url: 'https://retired.com/',
        da: 50,
        dr: 50,
        monthlyTraffic: 1000,
        priceUsd: 10,
        valueScore: 50,
        isActive: false,
        internalNotes: 'SECRET-SUPPLIER-NOTE',
      },
    ],
  })
}

beforeAll(async () => {
  await connectTestDb()
  await truncateAllTables()
  await seedTestDb()
  await seedTenants()
  app = await buildApp()
})

afterAll(async () => {
  await truncateAllTables()
  await app.close()
  await disconnectTestDb()
})

beforeEach(async () => {
  await prisma.backlinkOrderEvent.deleteMany()
  await prisma.backlinkOrderItem.deleteMany()
  await prisma.backlinkOrder.deleteMany()
  await prisma.backlinkCartItem.deleteMany()
  await prisma.backlinkSite.deleteMany()
  await seedCatalog()
})

// ── Catalog exposure ──────────────────────────────────────────────────────────

describe('GET /api/client/backlinks', () => {
  it('returns only active sites', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/client/backlinks', headers: asClient() })
    const body = JSON.parse(res.body)
    expect(res.statusCode).toBe(200)
    expect(body.sites.map((s) => s.domain).sort()).toEqual(['cheap.com', 'highda.com'])
  })

  it('never leaks internalNotes or isActive to a client', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/client/backlinks', headers: asClient() })
    expect(res.body).not.toContain('SECRET-SUPPLIER-NOTE')
    expect(res.body).not.toContain('internalNotes')
    for (const site of JSON.parse(res.body).sites) {
      expect(site).not.toHaveProperty('internalNotes')
      expect(site).not.toHaveProperty('isActive')
    }
  })

  it('cannot be tricked into revealing inactive sites via isActive=false', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/client/backlinks?isActive=false',
      headers: asClient(),
    })
    const body = JSON.parse(res.body)
    expect(body.sites.find((s) => s.domain === 'retired.com')).toBeUndefined()
  })

  it('applies price and authority filters', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/client/backlinks?maxPrice=10&minDa=20',
      headers: asClient(),
    })
    const body = JSON.parse(res.body)
    expect(body.sites.map((s) => s.domain)).toEqual(['cheap.com'])
  })

  it('rejects an unauthenticated request', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/client/backlinks' })
    expect(res.statusCode).toBe(401)
  })
})

describe('GET /api/admin/backlinks', () => {
  it('exposes internalNotes to the owner', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/backlinks', headers: asOwner() })
    const body = JSON.parse(res.body)
    expect(res.statusCode).toBe(200)
    expect(body.sites.find((s) => s.domain === 'highda.com').internalNotes).toBe(
      'SECRET-SUPPLIER-NOTE',
    )
  })

  it('includes inactive sites so the catalog can be managed', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/backlinks', headers: asOwner() })
    expect(JSON.parse(res.body).sites.map((s) => s.domain)).toContain('retired.com')
  })

  it('refuses a CLIENT token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/backlinks', headers: asClient() })
    expect(res.statusCode).toBe(403)
  })
})

// ── Target ownership ─────────────────────────────────────────────────────────

describe('POST /api/client/backlink-cart target validation', () => {
  it('accepts a page from the client own project', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/backlink-cart',
      headers: asClient(),
      payload: {
        backlinkSiteId: 'c0000000-0000-0000-0000-000000000002',
        projectId: IDS.projectId,
        targetType: 'PAGE',
        wpPageId: IDS.ownPageId,
        anchorText: 'our services',
      },
    })
    const body = JSON.parse(res.body)
    expect(res.statusCode).toBe(201)
    expect(body.wpPageId).toBe(IDS.ownPageId)
    expect(body.targetUrl).toBe('https://testagency.com/services')
  })

  it('rejects a wpPageId belonging to another client', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/backlink-cart',
      headers: asClient(),
      payload: {
        backlinkSiteId: 'c0000000-0000-0000-0000-000000000002',
        targetType: 'PAGE',
        wpPageId: IDS.rivalPageId,
      },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toMatch(/not found for this client/i)
  })

  it('rejects a projectId belonging to another client', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/backlink-cart',
      headers: asClient(),
      payload: {
        backlinkSiteId: 'c0000000-0000-0000-0000-000000000002',
        projectId: IDS.rivalProjectId,
        targetType: 'DOMAIN',
      },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toMatch(/not found for this client/i)
  })

  it('rejects a page that does not belong to the chosen project', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/backlink-cart',
      headers: asClient(),
      payload: {
        backlinkSiteId: 'c0000000-0000-0000-0000-000000000002',
        projectId: IDS.projectId,
        targetType: 'PAGE',
        wpPageId: IDS.rivalPageId,
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('resolves a domain target to the project website', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/backlink-cart',
      headers: asClient(),
      payload: {
        backlinkSiteId: 'c0000000-0000-0000-0000-000000000001',
        projectId: IDS.projectId,
        targetType: 'DOMAIN',
      },
    })
    const body = JSON.parse(res.body)
    expect(res.statusCode).toBe(201)
    expect(body.targetType).toBe('DOMAIN')
    expect(body.wpPageId).toBeNull()
    expect(body.targetUrl).toBe('https://testagency.com')
  })

  it('refuses an inactive site', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/backlink-cart',
      headers: asClient(),
      payload: {
        backlinkSiteId: 'c0000000-0000-0000-0000-000000000003',
        projectId: IDS.projectId,
        targetType: 'DOMAIN',
      },
    })
    expect(res.statusCode).toBe(404)
  })

  it('snapshots the price at the time of adding', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/backlink-cart',
      headers: asClient(),
      payload: {
        backlinkSiteId: 'c0000000-0000-0000-0000-000000000002',
        projectId: IDS.projectId,
        targetType: 'DOMAIN',
      },
    })
    expect(JSON.parse(res.body).unitPriceUsd).toBe(5)
  })
})

// ── Cart isolation ───────────────────────────────────────────────────────────

describe('cart isolation between clients', () => {
  async function addToCart(headers, projectId) {
    return app.inject({
      method: 'POST',
      url: '/api/client/backlink-cart',
      headers,
      payload: {
        backlinkSiteId: 'c0000000-0000-0000-0000-000000000002',
        projectId,
        targetType: 'DOMAIN',
      },
    })
  }

  it('keeps each client cart private', async () => {
    await addToCart(asClient(), IDS.projectId)
    await addToCart(asRival(), IDS.rivalProjectId)

    const mine = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/client/backlink-cart', headers: asClient() }))
        .body,
    )
    const theirs = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/client/backlink-cart', headers: asRival() }))
        .body,
    )

    expect(mine.itemCount).toBe(1)
    expect(theirs.itemCount).toBe(1)
    expect(mine.items[0].id).not.toBe(theirs.items[0].id)
    expect(mine.items[0].projectName).toBe('Test SEO Campaign')
    expect(theirs.items[0].projectName).toBe('Rival Campaign')
  })

  it('cannot delete another client cart item', async () => {
    const created = JSON.parse((await addToCart(asRival(), IDS.rivalProjectId)).body)
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/client/backlink-cart/${created.id}`,
      headers: asClient(),
    })
    expect(res.statusCode).toBe(404)
    expect(await prisma.backlinkCartItem.count({ where: { id: created.id } })).toBe(1)
  })

  it('cannot retarget another client cart item', async () => {
    const created = JSON.parse((await addToCart(asRival(), IDS.rivalProjectId)).body)
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/client/backlink-cart/${created.id}`,
      headers: asClient(),
      payload: { anchorText: 'hijacked' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('clearing a cart only affects the acting client', async () => {
    await addToCart(asClient(), IDS.projectId)
    await addToCart(asRival(), IDS.rivalProjectId)

    await app.inject({ method: 'DELETE', url: '/api/client/backlink-cart', headers: asClient() })

    expect(await prisma.backlinkCartItem.count({ where: { clientId: IDS.clientAccountId } })).toBe(0)
    expect(await prisma.backlinkCartItem.count({ where: { clientId: IDS.rivalClientId } })).toBe(1)
  })

  it('rejects the same site for the same target twice', async () => {
    await addToCart(asClient(), IDS.projectId)
    const second = await addToCart(asClient(), IDS.projectId)
    expect(second.statusCode).toBe(409)
  })
})

// ── Checkout ─────────────────────────────────────────────────────────────────

async function checkout(headers, projectId) {
  await app.inject({
    method: 'POST',
    url: '/api/client/backlink-cart',
    headers,
    payload: {
      backlinkSiteId: 'c0000000-0000-0000-0000-000000000001',
      projectId,
      targetType: 'DOMAIN',
      anchorText: 'anchor one',
    },
  })
  await app.inject({
    method: 'POST',
    url: '/api/client/backlink-cart',
    headers,
    payload: {
      backlinkSiteId: 'c0000000-0000-0000-0000-000000000002',
      projectId,
      targetType: 'DOMAIN',
      anchorText: 'anchor two',
    },
  })
  const res = await app.inject({
    method: 'POST',
    url: '/api/client/backlink-orders',
    headers,
    payload: { clientNotes: 'please prioritise' },
  })
  return JSON.parse(res.body)
}

describe('POST /api/client/backlink-orders', () => {
  it('creates a pending order, totals it, and empties the cart', async () => {
    const order = await checkout(asClient(), IDS.projectId)
    expect(order.status).toBe('PENDING_REVIEW')
    expect(order.itemCount).toBe(2)
    expect(order.totalUsd).toBe(45)
    expect(order.orderNumber).toMatch(/^BL-\d{4}-\d{4}$/)
    expect(order.items).toHaveLength(2)

    const cart = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/client/backlink-cart', headers: asClient() }))
        .body,
    )
    expect(cart.itemCount).toBe(0)
  })

  it('refuses to check out an empty cart', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/backlink-orders',
      headers: asClient(),
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toMatch(/empty/i)
  })

  it('freezes metric and price snapshots against later catalog edits', async () => {
    const order = await checkout(asClient(), IDS.projectId)
    const before = order.items.find((i) => i.domain === 'highda.com')
    expect(before.unitPriceUsd).toBe(40)
    expect(before.da).toBe(70)

    await app.inject({
      method: 'PATCH',
      url: '/api/admin/backlinks/c0000000-0000-0000-0000-000000000001',
      headers: asOwner(),
      payload: { priceUsd: 999, da: 12 },
    })

    const after = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/client/backlink-orders/${order.id}`,
          headers: asClient(),
        })
      ).body,
    )
    const item = after.items.find((i) => i.domain === 'highda.com')
    expect(item.unitPriceUsd).toBe(40)
    expect(item.da).toBe(70)
    expect(after.totalUsd).toBe(45)
  })

  it('records a submission event on the timeline', async () => {
    const order = await checkout(asClient(), IDS.projectId)
    const detail = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/client/backlink-orders/${order.id}`,
          headers: asClient(),
        })
      ).body,
    )
    expect(detail.events.some((e) => e.eventType === 'SUBMITTED')).toBe(true)
  })

  it('never includes adminNotes in a client order response', async () => {
    const order = await checkout(asClient(), IDS.projectId)
    await app.inject({
      method: 'PATCH',
      url: `/api/admin/backlink-orders/${order.id}`,
      headers: asOwner(),
      payload: { adminNotes: 'INTERNAL-MARGIN-NOTE' },
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/client/backlink-orders/${order.id}`,
      headers: asClient(),
    })
    expect(res.body).not.toContain('INTERNAL-MARGIN-NOTE')
    expect(JSON.parse(res.body)).not.toHaveProperty('adminNotes')
  })
})

// ── Order isolation ──────────────────────────────────────────────────────────

describe('order isolation between clients', () => {
  it('a client sees only its own orders', async () => {
    await checkout(asClient(), IDS.projectId)
    await checkout(asRival(), IDS.rivalProjectId)

    const mine = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/client/backlink-orders', headers: asClient() }))
        .body,
    )
    expect(mine.orders).toHaveLength(1)
    expect(mine.orders[0].clientId).toBe(IDS.clientAccountId)
  })

  it('returns 404 for another client order by id', async () => {
    const theirs = await checkout(asRival(), IDS.rivalProjectId)
    const res = await app.inject({
      method: 'GET',
      url: `/api/client/backlink-orders/${theirs.id}`,
      headers: asClient(),
    })
    expect(res.statusCode).toBe(404)
  })

  it('cannot cancel another client order', async () => {
    const theirs = await checkout(asRival(), IDS.rivalProjectId)
    const res = await app.inject({
      method: 'POST',
      url: `/api/client/backlink-orders/${theirs.id}/cancel`,
      headers: asClient(),
    })
    expect(res.statusCode).toBe(404)
    const still = await prisma.backlinkOrder.findUnique({ where: { id: theirs.id } })
    expect(still.status).toBe('PENDING_REVIEW')
  })

  it('lets a client cancel its own pending order but not an approved one', async () => {
    const order = await checkout(asClient(), IDS.projectId)

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/client/backlink-orders/${order.id}/cancel`,
      headers: asClient(),
    })
    expect(cancelled.statusCode).toBe(200)
    expect(JSON.parse(cancelled.body).status).toBe('CANCELLED')

    const second = await checkout(asClient(), IDS.projectId)
    await app.inject({
      method: 'PATCH',
      url: `/api/admin/backlink-orders/${second.id}`,
      headers: asOwner(),
      payload: { status: 'APPROVED' },
    })
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/client/backlink-orders/${second.id}/cancel`,
      headers: asClient(),
    })
    expect(blocked.statusCode).toBe(409)
  })
})

// ── Admin fulfilment ─────────────────────────────────────────────────────────

describe('admin order fulfilment', () => {
  it('approving an order releases its items for placement', async () => {
    const order = await checkout(asClient(), IDS.projectId)
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/backlink-orders/${order.id}`,
      headers: asOwner(),
      payload: { status: 'APPROVED' },
    })
    const body = JSON.parse(res.body)
    expect(res.statusCode).toBe(200)
    expect(body.status).toBe('APPROVED')
    expect(body.items.every((i) => i.status === 'IN_PROGRESS')).toBe(true)
    expect(body.approvedAt).toBeTruthy()
  })

  it('blocks an illegal status transition', async () => {
    const order = await checkout(asClient(), IDS.projectId)
    await app.inject({
      method: 'PATCH',
      url: `/api/admin/backlink-orders/${order.id}`,
      headers: asOwner(),
      payload: { status: 'REJECTED' },
    })
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/backlink-orders/${order.id}`,
      headers: asOwner(),
      payload: { status: 'APPROVED' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('pasting a live URL marks the item live and completes the order once all land', async () => {
    const order = await checkout(asClient(), IDS.projectId)
    await app.inject({
      method: 'PATCH',
      url: `/api/admin/backlink-orders/${order.id}`,
      headers: asOwner(),
      payload: { status: 'APPROVED' },
    })

    const [first, second] = order.items

    const afterFirst = JSON.parse(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/admin/backlink-order-items/${first.id}`,
          headers: asOwner(),
          payload: { liveUrl: 'https://highda.com/guest-post' },
        })
      ).body,
    )
    expect(afterFirst.items.find((i) => i.id === first.id).status).toBe('LIVE')
    expect(afterFirst.status).toBe('IN_PROGRESS')

    const afterSecond = JSON.parse(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/admin/backlink-order-items/${second.id}`,
          headers: asOwner(),
          payload: { liveUrl: 'https://cheap.com/profile' },
        })
      ).body,
    )
    expect(afterSecond.status).toBe('COMPLETED')
    expect(afterSecond.completedAt).toBeTruthy()
  })

  it('rejecting an order cancels its outstanding items', async () => {
    const order = await checkout(asClient(), IDS.projectId)
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/backlink-orders/${order.id}`,
      headers: asOwner(),
      payload: { status: 'REJECTED', reason: 'Niche not accepted' },
    })
    const body = JSON.parse(res.body)
    expect(body.status).toBe('REJECTED')
    expect(body.items.every((i) => i.status === 'CANCELLED')).toBe(true)
  })

  it('refuses fulfilment from a CLIENT token', async () => {
    const order = await checkout(asClient(), IDS.projectId)
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/backlink-order-items/${order.items[0].id}`,
      headers: asClient(),
      payload: { liveUrl: 'https://evil.com/self-serve' },
    })
    expect(res.statusCode).toBe(403)
  })
})

// ── Admin catalog management ──────────────────────────────────────────────────

describe('admin catalog management', () => {
  it('normalizes the domain on create and rejects a duplicate', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/backlinks',
      headers: asOwner(),
      payload: {
        domain: 'https://www.NewSite.com/pricing',
        da: 45,
        dr: 40,
        monthlyTraffic: 20000,
        priceUsd: 12,
      },
    })
    const body = JSON.parse(created.body)
    expect(created.statusCode).toBe(201)
    expect(body.domain).toBe('newsite.com')
    expect(body.valueScore).toBeGreaterThan(0)

    const dup = await app.inject({
      method: 'POST',
      url: '/api/admin/backlinks',
      headers: asOwner(),
      payload: { domain: 'newsite.com', da: 1, dr: 1, monthlyTraffic: 1, priceUsd: 1 },
    })
    expect(dup.statusCode).toBe(409)
  })

  it('recomputes valueScore when the price changes', async () => {
    const before = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/admin/backlinks', headers: asOwner() })).body,
    ).sites.find((s) => s.domain === 'cheap.com')

    const after = JSON.parse(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/admin/backlinks/c0000000-0000-0000-0000-000000000002',
          headers: asOwner(),
          payload: { priceUsd: 50 },
        })
      ).body,
    )
    expect(after.valueScore).toBeLessThan(before.valueScore)
  })

  it('deactivates rather than deletes a site with order history', async () => {
    await checkout(asClient(), IDS.projectId)
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/backlinks/c0000000-0000-0000-0000-000000000001',
      headers: asOwner(),
    })
    const body = JSON.parse(res.body)
    expect(body.deleted).toBe(false)
    expect(body.deactivated).toBe(true)
    expect(await prisma.backlinkSite.count({ where: { domain: 'highda.com' } })).toBe(1)
  })

  it('deletes a site that has never been ordered', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/backlinks/c0000000-0000-0000-0000-000000000003',
      headers: asOwner(),
    })
    expect(JSON.parse(res.body).deleted).toBe(true)
    expect(await prisma.backlinkSite.count({ where: { domain: 'retired.com' } })).toBe(0)
  })

  it('applies a bulk percentage price change', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/admin/backlinks/bulk',
      headers: asOwner(),
      payload: {
        ids: ['c0000000-0000-0000-0000-000000000002'],
        action: 'adjustPrice',
        percent: 100,
      },
    })
    const site = await prisma.backlinkSite.findUnique({
      where: { id: 'c0000000-0000-0000-0000-000000000002' },
    })
    expect(Number(site.priceUsd)).toBe(10)
  })

  it('bulk deactivates selected sites', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/admin/backlinks/bulk',
      headers: asOwner(),
      payload: {
        ids: ['c0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002'],
        action: 'deactivate',
      },
    })
    expect(await prisma.backlinkSite.count({ where: { isActive: true } })).toBe(0)
  })
})

// ── Import ───────────────────────────────────────────────────────────────────

describe('POST /api/admin/backlinks/import', () => {
  const payload = (sites) => ({ data: { sites }, dryRun: true, mode: 'merge' })

  it('reports what a dry run would do without writing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/backlinks/import',
      headers: asOwner(),
      payload: payload([
        { domain: 'brandnew.com', da: 50, dr: 50, monthlyTraffic: 10000, priceUsd: 15 },
        { domain: 'cheap.com', da: 30, dr: 35, monthlyTraffic: 5000, priceUsd: 9 },
      ]),
    })
    const { summary } = JSON.parse(res.body)
    expect(summary.dryRun).toBe(true)
    expect(summary.created).toBe(1)
    expect(summary.updated).toBe(1)
    expect(summary.priceChanges).toEqual([{ domain: 'cheap.com', fromUsd: 5, toUsd: 9 }])
    expect(await prisma.backlinkSite.count({ where: { domain: 'brandnew.com' } })).toBe(0)
  })

  it('upserts by domain when applied', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/admin/backlinks/import',
      headers: asOwner(),
      payload: {
        ...payload([{ domain: 'cheap.com', da: 33, dr: 35, monthlyTraffic: 5000, priceUsd: 9 }]),
        dryRun: false,
      },
    })
    const site = await prisma.backlinkSite.findUnique({ where: { domain: 'cheap.com' } })
    expect(Number(site.priceUsd)).toBe(9)
    expect(site.da).toBe(33)
    expect(await prisma.backlinkSite.count()).toBe(3)
  })

  it('quarantines invalid rows and still imports the good ones', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/backlinks/import',
      headers: asOwner(),
      payload: payload([
        { domain: 'good.com', da: 40, dr: 40, monthlyTraffic: 1000, priceUsd: 10 },
        { domain: 'bad.com', da: 261, dr: 40, monthlyTraffic: 1000, priceUsd: 10 },
        { domain: 'nopricing.com', da: 40, dr: 40, monthlyTraffic: 1000 },
      ]),
    })
    const { summary } = JSON.parse(res.body)
    expect(summary.valid).toBe(1)
    expect(summary.errorCount).toBe(2)
    expect(summary.errors.map((e) => e.domain).sort()).toEqual(['bad.com', 'nopricing.com'])
  })

  it('merges duplicate domains inside one payload keeping the highest price', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/backlinks/import',
      headers: asOwner(),
      payload: payload([
        { domain: 'dup.com', da: 40, dr: 20, monthlyTraffic: 1000, priceUsd: 5 },
        { domain: 'www.dup.com', da: 30, dr: 60, monthlyTraffic: 9000, priceUsd: 13 },
      ]),
    })
    const { summary } = JSON.parse(res.body)
    expect(summary.uniqueSites).toBe(1)
    expect(summary.mergedDuplicates).toBe(1)
    expect(summary.duplicateCollisions[0].resolvedPriceUsd).toBe(13)
  })

  it('rejects an empty payload and a CLIENT token', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: '/api/admin/backlinks/import',
      headers: asOwner(),
      payload: { data: { sites: [] }, dryRun: true },
    })
    expect(empty.statusCode).toBe(400)

    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/admin/backlinks/import',
      headers: asClient(),
      payload: payload([{ domain: 'x.com', da: 1, dr: 1, monthlyTraffic: 1, priceUsd: 1 }]),
    })
    expect(forbidden.statusCode).toBe(403)
  })
})

// ── Targets and facets ───────────────────────────────────────────────────────

describe('GET /api/client/backlinks/targets', () => {
  it('returns only the acting client projects and pages', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/client/backlinks/targets',
      headers: asClient(),
    })
    const body = JSON.parse(res.body)
    expect(body.projects).toHaveLength(1)
    expect(body.projects[0].id).toBe(IDS.projectId)
    expect(body.projects[0].pages.map((p) => p.id)).toEqual([IDS.ownPageId])
    expect(res.body).not.toContain(IDS.rivalPageId)
    expect(res.body).not.toContain('Rival')
  })
})

describe('GET /api/client/backlinks/facets', () => {
  it('reports bounds across active sites only', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/client/backlinks/facets',
      headers: asClient(),
    })
    const body = JSON.parse(res.body)
    expect(body.total).toBe(2)
    expect(body.priceUsd).toEqual({ min: 5, max: 40 })
    expect(body.da).toEqual({ min: 30, max: 70 })
  })
})
