/**
 * e2e O20 / O7: content-map reconcile on EmDash projects treats the OS's own drafts as the OS's own work:
 * the node a draft was pushed from is linked to the new entry (no second node), and a title / URL our push wrote
 * is followed by the node instead of raising site drift.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ calls: [], overrides: {} }));
vi.mock('../../../src/lib/prisma.js', () => {
  const model = (name) =>
    new Proxy({}, {
      get(_, method) {
        const key = `${name}.${String(method)}`;
        return async (args) => {
          db.calls.push({ key, args });
          if (db.overrides[key]) return db.overrides[key](args);
          if (method === 'findMany') return [];
          if (method === 'count') return 0;
          if (method === 'updateMany' || method === 'deleteMany') return { count: 1 };
          if (method === 'aggregate') return { _max: { sortOrder: 0 } };
          if (method === 'create' || method === 'update' || method === 'upsert') return { id: `row-${db.calls.length}`, ...(args?.data || args?.create || {}) };
          return null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});
const notified = vi.hoisted(() => []);
vi.mock('../../../src/lib/contentMapService.js', () => ({
  logEvent: vi.fn(async () => {}),
  publishContentMapUpdate: vi.fn(async () => {}),
  notifyContentMap: vi.fn(async (n) => notified.push(n)),
  resolveContentMapRecipients: vi.fn(async () => ({ project: { name: 'Oasis' }, recipientIds: ['owner'] })),
}));

import { reconcileMap } from '../../../src/lib/contentMapSync.js';

const calls = (key) => db.calls.filter((c) => c.key === key);
const PAGE = { id: 'wp-new', wpPostId: 132, title: 'Hot Tub Heater Repair', slug: 'hot-tub-heater-repair', status: 'draft', postType: 'pages', url: 'https://oasispoolspas.com/spa-services/hot-tub-heater-repair/', content: '', cmsEntryId: 'E132', modifiedAt: new Date() };

function setup({ nodes, pages, drafts }) {
  db.overrides['contentMap.findUnique'] = async () => ({ id: 'm1', projectId: 'p1', name: 'Map' });
  db.overrides['contentMapSync.findUnique'] = async () => ({ mapId: 'm1', firstImportAt: new Date(), includePostTypes: null, autoAdopt: true });
  db.overrides['contentMapNode.findMany'] = async () => nodes;
  db.overrides['wpPage.findMany'] = async () => pages;
  db.overrides['project.findUnique'] = async () => ({ cmsHealth: {} });
  db.overrides['cmsDraft.findMany'] = async () => drafts;
}

beforeEach(() => {
  db.calls = [];
  db.overrides = {};
  notified.length = 0;
});

describe('e2e O20: the pushing node is linked to the entry it created', () => {
  it('links the IN_PIPELINE node by the draft cmsEntryId: no second node, no NEW_CONTENT drift', async () => {
    const node = { id: 'n-planned', name: 'Heater repair', url: null, slug: '/spa-services/heater-repair/', lifecycle: 'IN_PIPELINE', wpPageId: null, source: 'PLANNED' };
    const wpNode = { id: 'n-wp', name: 'Home', url: 'https://oasispoolspas.com/', slug: '/', lifecycle: 'LIVE', wpPageId: 'wp-home', source: 'WORDPRESS' };
    setup({
      nodes: [node, wpNode],
      pages: [{ ...PAGE, id: 'wp-home', title: 'Home', url: 'https://oasispoolspas.com/', status: 'published', cmsEntryId: 'E1' }, PAGE],
      drafts: [{ cmsEntryId: 'E132', contentMapNodeId: 'n-planned', title: PAGE.title, cmsPath: '/spa-services/hot-tub-heater-repair/', lastPushStatus: 'ok' }],
    });
    const r = await reconcileMap('m1', { notify: true });
    expect(r.ok).toBe(true);
    const link = calls('contentMapNode.update').find((c) => c.args.where.id === 'n-planned');
    expect(link.args.data).toMatchObject({ wpPageId: 'wp-new', url: PAGE.url });
    expect(calls('contentMapNode.create')).toHaveLength(0); // autoAdopt on: still no second node
    expect(calls('contentMapDrift.create').filter((c) => c.args.data.driftType === 'NEW_CONTENT')).toHaveLength(0);
  });

  it('WordPress maps (no cmsEntryId) never look at drafts', async () => {
    setup({ nodes: [{ id: 'n1', name: 'Home', url: 'https://wp.example/', slug: '/', lifecycle: 'LIVE', wpPageId: 'wp1' }], pages: [{ ...PAGE, id: 'wp1', url: 'https://wp.example/', title: 'Home', status: 'publish', cmsEntryId: null }], drafts: [] });
    await reconcileMap('m1', { notify: false });
    expect(calls('cmsDraft.findMany')).toHaveLength(0);
  });
});

describe('e2e O7: the OS’s own pushes are not site drift', () => {
  const linkedNode = { id: 'n1', name: 'Heater repair', url: 'https://oasispoolspas.com/spa-services/heater-repair/', slug: '/spa-services/heater-repair/', lifecycle: 'IN_PIPELINE', wpPageId: 'wp-new', source: 'PLANNED' };

  it('a title and URL written by this node’s pushed draft: the node follows, no drift, no notification', async () => {
    setup({
      nodes: [linkedNode],
      pages: [PAGE],
      drafts: [{ cmsEntryId: 'E132', contentMapNodeId: 'n1', title: PAGE.title, cmsPath: '/spa-services/hot-tub-heater-repair/', lastPushStatus: 'ok' }],
    });
    await reconcileMap('m1', { notify: true });
    expect(calls('contentMapNode.update').at(-1).args.data).toMatchObject({ name: PAGE.title, url: PAGE.url, slug: '/spa-services/hot-tub-heater-repair/' });
    expect(calls('contentMapDrift.create')).toHaveLength(0);
    expect(notified.filter((n) => n.slug === 'content_map_site_drift')).toHaveLength(0);
  });

  it('a change somebody made on the site (not what we pushed) is still drift', async () => {
    setup({
      nodes: [linkedNode],
      pages: [{ ...PAGE, title: 'Edited in the site admin' }],
      drafts: [{ cmsEntryId: 'E132', contentMapNodeId: 'n1', title: PAGE.title, cmsPath: '/spa-services/heater-repair/', lastPushStatus: 'ok' }],
    });
    await reconcileMap('m1', { notify: true });
    const types = calls('contentMapDrift.create').map((c) => c.args.data.driftType);
    expect(types).toEqual(expect.arrayContaining(['TITLE_CHANGED', 'URL_CHANGED']));
    expect(notified.filter((n) => n.slug === 'content_map_site_drift')).toHaveLength(1);
  });

  it('a draft that failed to push, or another node’s draft, does not hide drift', async () => {
    setup({
      nodes: [linkedNode],
      pages: [PAGE],
      drafts: [{ cmsEntryId: 'E132', contentMapNodeId: 'n1', title: PAGE.title, cmsPath: '/spa-services/hot-tub-heater-repair/', lastPushStatus: 'failed' }],
    });
    await reconcileMap('m1', { notify: false });
    expect(calls('contentMapDrift.create').map((c) => c.args.data.driftType)).toContain('TITLE_CHANGED');
  });
});
