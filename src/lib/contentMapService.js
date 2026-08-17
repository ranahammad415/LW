/**
 * Content Map service — shorthand tree parse/normalize (ported from
 * Content Map HTML/content-map.html), import/export, stats, events, notify.
 */
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { prisma } from './prisma.js';
import { notify } from './notificationService.js';
import { publish } from './realtimeBus.js';

const KIND_BY_DEPTH = ['ROOT', 'PILLAR', 'CLUSTER', 'PAGE'];
const KIND_TO_SHORTHAND = { ROOT: 'root', PILLAR: 'pillar', CLUSTER: 'cluster', PAGE: 'page' };

/* ---------- Default strategy sections (from content-map.html) ---------- */

export const DEFAULT_SECTIONS = {
  types: [
    ['Pillar (level 1)', 'Convert, and act as the table of contents for its clusters', 'The 3 live service hubs', '3 pages, kept current'],
    ['Cluster page (level 2)', 'Own one head commercial topic and list its children', 'Local SEO, AEO, FlowSeries, lead capture', 'Publish these before their children'],
    ['Supporting page (level 3)', 'Answer one narrow question and link back up', 'What is AEO, click-to-call, speed to lead', 'The long tail of the map'],
    ['Product page', 'Give a named offer its own URL', 'FlowSeries, WaveWorks', '2 level-2 pages'],
    ['Offer / pricing page', 'Carry the price and the promo', 'SEO pricing, free website with annual plan', '1 cluster plus its children'],
    ['Industry page', 'Same services, one specific buyer', 'Attorneys, electrical, childcare', '4 clusters, 18 level-3 pages'],
    ['Local page', 'Geo intent plus trust', 'Milwaukee metro, then individual cities', 'Gate the city pages behind real local proof'],
    ['Case study', 'Sales proof and citable evidence', 'The 5 homepage testimonials as full pages', '1 per industry page'],
    ['Comparison', 'Catch in-market shoppers', 'SEO vs AEO, FlowSeries vs WaveWorks', '5 level-3 pages'],
    ['Glossary / definition', 'Short source pages AI tools can quote', 'AEO, schema, local pack, RAG bot', '1 per key term'],
    ['Playbook / template', 'Earn links and give the silo internal anchors', 'GBP checklist, bottleneck map', '5 level-3 pages'],
    ['FAQ page', 'Turn the FAQs already on the hubs into indexable URLs', 'Website, SEO/AEO, automation, pricing', '1 per pillar'],
  ],
  templates: [
    { c: 'var(--web)', t: 'Level 2 — cluster page', b: 'Owns the head term. Problem, how it works, what is included, proof, then a block that links every level-3 child it owns. Pillar linked in the first 100 words.', n: '1200–1800 words' },
    { c: 'var(--seo)', t: 'Level 3 — supporting page', b: 'One question, one answer. Direct answer up top for AI extraction, detail, then up-link to its level-2 parent and 2 siblings. No link straight to the pillar.', n: '700–1100 words' },
    { c: 'var(--ind)', t: 'Industry page', b: 'Industry problem, then three service blocks (site, visibility, follow-up) each linking a pillar, then a quote or case, then discovery-call CTA.', n: '800–1200 words' },
    { c: 'var(--local)', t: 'Local page', b: 'Who you serve, local proof, map embed, GBP link, services with pillar links. No duplicated boilerplate across cities.', n: '700–1000 words' },
    { c: 'var(--seo)', t: 'Definition / glossary', b: 'One-paragraph answer up top for AI extraction, then detail, then how Local Waves applies it. FAQ schema on every one.', n: '500–800 words' },
    { c: 'var(--proof)', t: 'Case study', b: 'Situation, constraint, what was built, measurable result, quote. Links to the industry page and the pillar that did the work.', n: '600–900 words' },
    { c: 'var(--auto)', t: 'Product page', b: 'What it is, what is included, deploy time, who it fits, price signal, CTA. Links to sibling product and the hub.', n: '700–1000 words' },
  ],
  rules: [
    ['Level 1 pillar', 'Down to every level-2 cluster it owns', 'An “Explore this topic” block — the pillar is the table of contents'],
    ['Level 2 cluster page', 'Down to all of its level-3 pages', 'A cluster page that does not list its children is not a hub'],
    ['Level 2 cluster page', 'Up to its pillar, in the first 100 words', 'Passes the topical signal back up the silo'],
    ['Level 3 supporting page', 'Up to its level-2 parent', 'Never straight to the pillar — climb one step at a time'],
    ['Level 3 supporting page', '2 siblings inside the same cluster', 'Keeps the visit in the silo and spreads equity sideways'],
    ['Every page', '/contact-us/ or the booking widget', 'One clear conversion path, mid-page or at the end'],
    ['Cross-silo links', 'Only where the job genuinely overlaps', '1–2 per page maximum, or the silos blur together'],
    ['Industry pages (level 3)', 'All 3 pillars', 'One vertical needs all three services'],
    ['Local pages (level 3)', 'Local SEO cluster + About + Contact', 'Local intent should not dead-end on a thin geo page'],
    ['Case studies', 'The industry page + the pillar that did the work', 'Proof should feed a commercial page, not sit alone'],
    ['Glossary pages', 'The commercial page for that term', 'Definition traffic has to route somewhere'],
    ['Anything new', 'Its declared parent, before it is written', 'No orphans, and no links to the stale leftover URLs'],
  ],
  checklist: [
    ['Breadcrumb', 'Home → Pillar → Cluster → This page (with BreadcrumbList schema)'],
    ['Intro paragraph', 'Its direct parent, one level up, in natural language'],
    ['Body', '2 siblings from the same cluster'],
    ['Children block (level 1 and 2 only)', 'Every child page it owns'],
    ['Cross-silo link', '1 related page, only if the job overlaps'],
    ['Mid or end CTA', '/contact-us/ or the booking widget'],
    ['Schema', 'FAQPage or Service, plus LocalBusiness on geo pages'],
  ],
  bridges: [
    ['Website lead capture', 'Lead follow-up automation', 'A form without follow-up is the exact problem they already pitch'],
    ['Website CRM & booking', 'CRM integrations, WaveWorks', 'Same job, different depth of build'],
    ['Automated review requests', 'GBP, Local SEO', 'Reviews are a local ranking input'],
    ['Hosting & free-site offer', 'Local SEO pricing', 'The promo only makes sense paired with the SEO plan'],
    ['AI content creation', 'Content strategy for search & AI', 'Production feeds strategy'],
    ['Website speed', 'Technical SEO foundation', 'One is the symptom, one is the system'],
    ['AI receptionist', 'Trades and childcare industry pages', 'Missed calls are the sharpest pain in those verticals'],
  ],
  cleanup: [
    ['/home/ — old homepage with placeholder testimonials', '301 → /'],
    ['/digital-marketing/ — LaunchWave / GrowthWave / PowerWave tiers', 'Merge into a packages page or redirect'],
    ['/automation-ai-systems/ — duplicate of the automation hub', '301 → /workflow-automation/'],
    ['locations.kml — no address or coordinates', 'Fill GBP and the KML before any city page'],
    ['/about-us/ — live but missing from nav', 'Add to nav or footer; link from the Milwaukee page'],
    ['The 3 hubs have no spoke links yet', 'Add an “Explore this topic” block to each'],
  ],
  avoid: [
    ['The level-3 city pages, for now', 'They are mapped but stay P3 — swapped-name pages are duplicate content until each city has real local proof'],
    ['A fourth level below a supporting page', 'Anything deeper than three levels is a sign the cluster above it should have been split instead'],
    ['Generic “what is SEO” content', 'Ignores the AEO angle that actually differentiates the offer'],
    ['A second automation or website hub', 'Would cannibalize a live pillar that already ranks'],
    ['Links to /home/ or /automation-ai-systems/', 'Sends equity into pages that should be redirected'],
    ['Blog posts with no parent hub', 'Orphan URLs that never lift a service page'],
  ],
};

/* ---------- Zod validation ---------- */

const shorthandNodeSchema = z.lazy(() =>
  z
    .object({
      id: z.string().optional(),
      n: z.string().optional(),
      name: z.string().optional(),
      s: z.string().optional(),
      slug: z.string().optional(),
      p: z.string().optional(),
      pri: z.string().optional(),
      t: z.string().optional(),
      type: z.string().optional(),
      i: z.string().optional(),
      intent: z.string().optional(),
      l: z.array(z.string()).optional(),
      links: z.array(z.string()).optional(),
      c: z.array(shorthandNodeSchema).optional(),
      children: z.array(shorthandNodeSchema).optional(),
      accent: z.string().optional(),
      note: z.string().optional(),
      todo: z.string().optional(),
      live: z.boolean().optional(),
      fix: z.boolean().optional(),
      support: z.boolean().optional(),
      kind: z.string().optional(),
    })
    .refine((n) => !!(n.n || n.name), { message: 'Each node needs a name (n or name)' })
);

const flatNodeSchema = z.object({
  id: z.string().optional(),
  parentId: z.string().nullable().optional(),
  kind: z.enum(['ROOT', 'PILLAR', 'CLUSTER', 'PAGE', 'root', 'pillar', 'cluster', 'page']).optional(),
  name: z.string().min(1),
  slug: z.string().nullable().optional(),
  priority: z.string().nullable().optional(),
  contentType: z.string().nullable().optional(),
  intent: z.string().nullable().optional(),
  accent: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  todo: z.string().nullable().optional(),
  links: z.array(z.string()).nullable().optional(),
  isLive: z.boolean().optional(),
  needsFix: z.boolean().optional(),
  isSupport: z.boolean().optional(),
  sortOrder: z.number().optional(),
  posX: z.number().nullable().optional(),
  posY: z.number().nullable().optional(),
});

export function validateImport(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, errors: ['Payload must be a JSON object'] };
  }

  // Flat shape: { nodes: [...] } or { tree: {...} } or bare shorthand root
  if (Array.isArray(payload.nodes)) {
    const results = payload.nodes.map((n, i) => {
      const r = flatNodeSchema.safeParse(n);
      return r.success ? null : { index: i, errors: r.error.flatten().fieldErrors };
    }).filter(Boolean);
    if (results.length) return { ok: false, errors: results, shape: 'flat' };
    return { ok: true, shape: 'flat', data: payload.nodes };
  }

  const tree = payload.tree || payload.root || payload;
  const r = shorthandNodeSchema.safeParse(tree);
  if (!r.success) {
    return { ok: false, errors: r.error.flatten(), shape: 'shorthand' };
  }
  return { ok: true, shape: 'shorthand', data: tree, sections: payload.sections };
}

/* ---------- Parse / normalize shorthand tree ---------- */

function pillarOfNormalized(node) {
  let n = node;
  while (n && n.kind !== 'PILLAR') n = n._parent;
  return n;
}

/**
 * Expand a shorthand (or mixed) tree into a flat list of normalized node objects
 * ready for DB insert. Does not touch the DB.
 */
export function parseShorthandTree(rootPayload) {
  const flat = [];
  let autoId = 0;

  function normalize(node, parent, depth, sortOrder) {
    const kind = (node.kind || KIND_BY_DEPTH[Math.min(depth, KIND_BY_DEPTH.length - 1)]).toUpperCase();
    const name = node.n || node.name || '';
    const id = node.id || `tmp-${++autoId}`;

    let slug = node.s || node.slug || '';
    if (typeof slug === 'string' && slug.startsWith('...') && parent?.slug) {
      slug = parent.slug + slug.slice(4);
    }

    const priority = node.p || node.pri || node.priority || (parent ? parent.priority : undefined) || null;
    const intent = node.i || node.intent || (parent ? parent.intent : undefined) || null;
    const contentType =
      node.t ||
      node.type ||
      node.contentType ||
      (kind === 'CLUSTER' ? 'Cluster hub' : kind === 'PAGE' ? 'Supporting page' : null);
    const needsFix = node.fix !== undefined ? !!node.fix : !!(parent && parent.needsFix);
    const isLive = !!node.live || !!node.isLive;
    const isSupport = !!node.support || !!node.isSupport;
    const accent = node.accent || (parent ? parent.accent : null);
    const children = node.c || node.children || [];

    let links = node.links || node.l || null;
    if (!links) {
      if (kind === 'PAGE') {
        links = [
          'Up to ' + (parent ? parent.name : 'its cluster'),
          '2 siblings in the same cluster',
          '/contact-us/',
        ];
      } else if (kind === 'CLUSTER') {
        links = [
          'Down to its ' + children.length + ' supporting pages',
          'Up to its pillar',
          '/contact-us/',
        ];
      } else if (kind === 'PILLAR') {
        links = ['Down to its ' + children.length + ' cluster pages', 'Home', '/contact-us/'];
      }
    }

    const normalized = {
      id,
      parentId: parent ? parent.id : null,
      kind,
      name,
      slug: slug || null,
      priority,
      contentType,
      intent,
      accent,
      note: node.note || null,
      todo: node.todo || null,
      links: links || null,
      isLive,
      needsFix,
      isSupport,
      sortOrder: sortOrder ?? 0,
      posX: node.posX ?? null,
      posY: node.posY ?? null,
      collapsed: kind === 'CLUSTER',
      _parent: parent,
      _children: [],
    };

    flat.push(normalized);
    children.forEach((child, idx) => {
      const childNode = normalize(child, normalized, depth + 1, idx);
      normalized._children.push(childNode);
    });

    // Fix cluster "up to pillar" link now that parent chain exists
    if (kind === 'CLUSTER' && Array.isArray(normalized.links)) {
      const pil = pillarOfNormalized(normalized);
      if (pil && normalized.links[1]?.startsWith('Up to')) {
        normalized.links[1] = 'Up to ' + pil.name;
      }
    }

    return normalized;
  }

  normalize(rootPayload, null, 0, 0);
  return flat.map(({ _parent, _children, ...rest }) => rest);
}

export function parseFlatNodes(nodes) {
  return nodes.map((n, idx) => ({
    id: n.id || `tmp-${idx + 1}`,
    parentId: n.parentId ?? null,
    kind: (n.kind || 'PAGE').toUpperCase(),
    name: n.name,
    slug: n.slug ?? null,
    priority: n.priority ?? null,
    contentType: n.contentType ?? null,
    intent: n.intent ?? null,
    accent: n.accent ?? null,
    note: n.note ?? null,
    todo: n.todo ?? null,
    links: n.links ?? null,
    isLive: !!n.isLive,
    needsFix: !!n.needsFix,
    isSupport: !!n.isSupport,
    sortOrder: n.sortOrder ?? idx,
    posX: n.posX ?? null,
    posY: n.posY ?? null,
    collapsed: (n.kind || '').toUpperCase() === 'CLUSTER',
  }));
}

/* ---------- Tree / stats ---------- */

export function buildTreeFromRows(rows) {
  const byId = new Map();
  rows.forEach((r) => byId.set(r.id, { ...r, children: [] }));
  let root = null;
  byId.forEach((node) => {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId).children.push(node);
    } else if (node.kind === 'ROOT' || !node.parentId) {
      root = node;
    }
  });
  byId.forEach((node) => {
    node.children.sort((a, b) => a.sortOrder - b.sortOrder);
  });
  return root || (rows[0] ? byId.get(rows[0].id) : null);
}

export async function buildTree(mapId) {
  const rows = await prisma.contentMapNode.findMany({
    where: { mapId },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  return { rows, tree: buildTreeFromRows(rows) };
}

export function computeStats(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const pillars = list.filter((n) => n.kind === 'PILLAR' && !n.needsFix).length;
  const clusters = list.filter((n) => n.kind === 'CLUSTER' && !n.needsFix).length;
  const pages = list.filter((n) => n.kind === 'PAGE' && !n.needsFix).length;
  const urls = list.filter(
    (n) => (n.kind === 'CLUSTER' || n.kind === 'PAGE') && !n.needsFix
  ).length;
  const p1 = list.filter(
    (n) => (n.kind === 'CLUSTER' || n.kind === 'PAGE') && !n.needsFix && n.priority === 'P1'
  ).length;
  const commentCounts = {}; // filled by caller if needed
  return { pillars, clusters, pages, urls, p1, total: list.length, commentCounts };
}

/* ---------- Export to shorthand ---------- */

export function exportToShorthand(rows) {
  const tree = buildTreeFromRows(rows);
  if (!tree) return null;

  function toShort(node) {
    const out = { n: node.name };
    if (node.slug) out.s = node.slug;
    if (node.priority) out.p = node.priority;
    if (node.contentType && node.contentType !== 'Cluster hub' && node.contentType !== 'Supporting page') {
      out.t = node.contentType;
    }
    if (node.intent) out.i = node.intent;
    if (node.accent) out.accent = node.accent;
    if (node.note) out.note = node.note;
    if (node.todo) out.todo = node.todo;
    if (node.isLive) out.live = true;
    if (node.needsFix) out.fix = true;
    if (node.isSupport) out.support = true;
    if (node.id && !node.id.startsWith('tmp-')) out.id = node.id;
    if (Array.isArray(node.links) && node.links.length) out.l = node.links;
    if (node.children?.length) out.c = node.children.map(toShort);
    return out;
  }

  return toShort(tree);
}

/* ---------- Version snapshot ---------- */

export async function snapshotMap(mapId, authorId, changeSummary) {
  const map = await prisma.contentMap.findUnique({
    where: { id: mapId },
    include: { nodes: true },
  });
  if (!map) return null;

  const last = await prisma.contentMapVersion.findFirst({
    where: { mapId },
    orderBy: { versionNumber: 'desc' },
    select: { versionNumber: true },
  });
  const versionNumber = (last?.versionNumber || 0) + 1;

  return prisma.contentMapVersion.create({
    data: {
      mapId,
      versionNumber,
      authorId: authorId || null,
      changeSummary: (changeSummary || 'Snapshot').slice(0, 500),
      snapshot: {
        name: map.name,
        status: map.status,
        sections: map.sections,
        settings: map.settings,
        nodes: map.nodes.map((n) => ({
          id: n.id,
          parentId: n.parentId,
          kind: n.kind,
          name: n.name,
          slug: n.slug,
          priority: n.priority,
          contentType: n.contentType,
          intent: n.intent,
          accent: n.accent,
          note: n.note,
          todo: n.todo,
          links: n.links,
          isLive: n.isLive,
          needsFix: n.needsFix,
          isSupport: n.isSupport,
          sortOrder: n.sortOrder,
          posX: n.posX,
          posY: n.posY,
          collapsed: n.collapsed,
          nodeStatus: n.nodeStatus,
          pmDecision: n.pmDecision,
          clientDecision: n.clientDecision,
        })),
      },
    },
  });
}

/* ---------- Import ---------- */

function nodeFieldsForDb(n, mapId, idMap) {
  const newId = idMap.get(n.id) || randomUUID();
  idMap.set(n.id, newId);
  return {
    id: newId,
    mapId,
    parentId: n.parentId ? idMap.get(n.parentId) || null : null,
    kind: n.kind,
    name: n.name.slice(0, 500),
    slug: n.slug ? String(n.slug).slice(0, 500) : null,
    priority: n.priority ? String(n.priority).slice(0, 10) : null,
    contentType: n.contentType ? String(n.contentType).slice(0, 100) : null,
    intent: n.intent ? String(n.intent).slice(0, 100) : null,
    accent: n.accent ? String(n.accent).slice(0, 50) : null,
    note: n.note || null,
    todo: n.todo || null,
    links: n.links || undefined,
    isLive: !!n.isLive,
    needsFix: !!n.needsFix,
    isSupport: !!n.isSupport,
    sortOrder: n.sortOrder ?? 0,
    posX: n.posX ?? null,
    posY: n.posY ?? null,
    collapsed: !!n.collapsed,
  };
}

/**
 * Import validated payload into a map.
 * @param {string} mapId
 * @param {object} payload
 * @param {{ mode?: 'replace'|'merge', dryRun?: boolean, authorId?: string }} options
 */
export async function importIntoMap(mapId, payload, options = {}) {
  const mode = options.mode === 'merge' ? 'merge' : 'replace';
  const dryRun = !!options.dryRun;
  const authorId = options.authorId || null;

  const validation = validateImport(payload);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }

  let incoming;
  if (validation.shape === 'flat') {
    incoming = parseFlatNodes(validation.data);
  } else {
    incoming = parseShorthandTree(validation.data);
  }

  const existing = await prisma.contentMapNode.findMany({ where: { mapId } });
  const bySlug = new Map();
  existing.forEach((n) => {
    if (n.slug) bySlug.set(n.slug, n);
  });

  const added = [];
  const changed = [];
  const removed = [];
  const kept = [];

  const incomingSlugs = new Set(incoming.filter((n) => n.slug).map((n) => n.slug));

  for (const n of incoming) {
    const match = n.slug ? bySlug.get(n.slug) : null;
    if (match) {
      const same =
        match.name === n.name &&
        match.kind === n.kind &&
        match.priority === n.priority &&
        match.contentType === n.contentType &&
        match.intent === n.intent;
      if (same) kept.push({ slug: n.slug, id: match.id });
      else changed.push({ slug: n.slug, id: match.id, name: n.name });
    } else {
      added.push({ slug: n.slug, name: n.name, kind: n.kind });
    }
  }

  if (mode === 'replace') {
    for (const e of existing) {
      if (e.slug && !incomingSlugs.has(e.slug)) {
        removed.push({ slug: e.slug, id: e.id, name: e.name });
      } else if (!e.slug) {
        // nodes without slug are removed on replace unless they match by id
        const byId = incoming.find((i) => i.id === e.id);
        if (!byId) removed.push({ slug: e.slug, id: e.id, name: e.name });
      }
    }
  }

  const diff = {
    added: added.length,
    changed: changed.length,
    removed: removed.length,
    kept: kept.length,
    addedItems: added.slice(0, 50),
    changedItems: changed.slice(0, 50),
    removedItems: removed.slice(0, 50),
  };

  if (dryRun) {
    return { ok: true, dryRun: true, diff, nodeCount: incoming.length };
  }

  if (mode === 'replace') {
    await snapshotMap(mapId, authorId, 'Before replace import');
    await prisma.contentMapNode.deleteMany({ where: { mapId } });

    // Insert in parent-before-child order (incoming is already DFS order)
    const idMap = new Map();
    for (const n of incoming) {
      idMap.set(n.id, randomUUID());
    }
    // Second pass: ensure parents exist in idMap
    for (const n of incoming) {
      const data = nodeFieldsForDb(n, mapId, idMap);
      // parentId may still be null for root; for others resolve
      if (n.parentId) {
        data.parentId = idMap.get(n.parentId) || null;
      }
      await prisma.contentMapNode.create({ data });
    }
  } else {
    // merge: update by slug, create missing, leave unmatched alone
    await snapshotMap(mapId, authorId, 'Before merge import');
    const idMap = new Map();
    // Preserve existing ids for matched slugs
    for (const n of incoming) {
      const match = n.slug ? bySlug.get(n.slug) : null;
      if (match) idMap.set(n.id, match.id);
      else idMap.set(n.id, randomUUID());
    }
    // Need parent ids: if parent was matched by slug, use its existing id
    for (const n of incoming) {
      const dbId = idMap.get(n.id);
      const match = n.slug ? bySlug.get(n.slug) : null;
      const parentDbId = n.parentId ? idMap.get(n.parentId) || null : null;
      const fields = {
        mapId,
        parentId: parentDbId,
        kind: n.kind,
        name: n.name.slice(0, 500),
        slug: n.slug ? String(n.slug).slice(0, 500) : null,
        priority: n.priority ? String(n.priority).slice(0, 10) : null,
        contentType: n.contentType ? String(n.contentType).slice(0, 100) : null,
        intent: n.intent ? String(n.intent).slice(0, 100) : null,
        accent: n.accent ? String(n.accent).slice(0, 50) : null,
        note: n.note || null,
        todo: n.todo || null,
        links: n.links || undefined,
        isLive: !!n.isLive,
        needsFix: !!n.needsFix,
        isSupport: !!n.isSupport,
        sortOrder: n.sortOrder ?? 0,
      };
      if (match) {
        await prisma.contentMapNode.update({ where: { id: match.id }, data: fields });
      } else {
        await prisma.contentMapNode.create({ data: { id: dbId, ...fields, collapsed: !!n.collapsed } });
      }
    }
  }

  if (validation.sections) {
    await prisma.contentMap.update({
      where: { id: mapId },
      data: { sections: validation.sections },
    });
  }

  await snapshotMap(mapId, authorId, mode === 'replace' ? 'After replace import' : 'After merge import');

  return { ok: true, dryRun: false, diff, nodeCount: incoming.length };
}

/* ---------- Events / notify / realtime ---------- */

export async function logEvent({ mapId, nodeId = null, userId = null, eventType, message = null, metadata = null }) {
  return prisma.contentMapEvent.create({
    data: {
      mapId,
      nodeId,
      userId,
      eventType: String(eventType).slice(0, 100),
      message: message ? String(message).slice(0, 500) : null,
      metadata: metadata || undefined,
    },
  });
}

export async function publishContentMapUpdate(projectId, payload = {}) {
  publish(projectId, 'content-map:updated', payload);
}

export async function notifyContentMap({ slug, recipientIds, variables = {}, actionUrl = null, metadata = null }) {
  if (!recipientIds?.length) return;
  return notify({ slug, recipientIds, variables, actionUrl, metadata });
}

/**
 * Resolve staff + client recipients for a project’s content map notifications.
 */
export async function resolveContentMapRecipients(projectId, { includeClients = false } = {}) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      leadPmId: true,
      clientId: true,
      client: { select: { leadPmId: true, secondaryPmId: true } },
    },
  });
  if (!project) return { project: null, recipientIds: [] };

  const ids = new Set();
  if (project.leadPmId) ids.add(project.leadPmId);
  if (project.client?.leadPmId) ids.add(project.client.leadPmId);
  if (project.client?.secondaryPmId) ids.add(project.client.secondaryPmId);

  const owners = await prisma.user.findMany({
    where: { role: 'OWNER', isActive: true },
    select: { id: true },
  });
  owners.forEach((o) => ids.add(o.id));

  if (includeClients && project.clientId) {
    const clientUsers = await prisma.clientUser.findMany({
      where: { clientId: project.clientId },
      select: { userId: true },
    });
    clientUsers.forEach((cu) => ids.add(cu.userId));
  }

  return { project, recipientIds: [...ids] };
}

export async function getMapWithTree(mapId) {
  const map = await prisma.contentMap.findUnique({
    where: { id: mapId },
    include: {
      createdBy: { select: { id: true, name: true, role: true } },
      _count: { select: { comments: true, nodes: true, versions: true } },
    },
  });
  if (!map) return null;
  const { rows, tree } = await buildTree(mapId);
  const stats = computeStats(rows);

  const commentGroups = await prisma.contentMapComment.groupBy({
    by: ['nodeId'],
    where: { mapId },
    _count: { _all: true },
  });
  const commentCounts = {};
  commentGroups.forEach((g) => {
    commentCounts[g.nodeId || '__map__'] = g._count._all;
  });
  stats.commentCounts = commentCounts;

  return { map, rows, tree, stats };
}

export { KIND_BY_DEPTH, KIND_TO_SHORTHAND };
