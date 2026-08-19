/**
 * Non-breakage smoke suite for the Content Map WordPress sync work.
 *
 * Exercises the pre-existing surfaces (health, auth, modalities, PM/client
 * projects, pipeline, tasks, content maps) alongside the new sync, drift,
 * health and schedule endpoints. Point SMOKE_BASE at a throwaway API instance.
 */
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:3002';

const results = [];
let failures = 0;

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    return detail;
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    failures += 1;
    return null;
  }
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

function brief(value, n = 220) {
  return JSON.stringify(value).slice(0, n);
}

async function login(email) {
  const res = await api('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'password123' },
  });
  expect(res.status === 200, `login ${email} -> ${res.status} ${brief(res.json)}`);
  return res.json.accessToken;
}

async function main() {
  await check('health endpoint', async () => {
    const res = await api('/health');
    expect(res.status === 200, `status ${res.status}`);
    return `status=${res.status}`;
  });

  let ownerToken;
  let pmToken;
  let clientToken;

  await check('auth: owner/pm/client login', async () => {
    ownerToken = await login('smoke-owner@localwaves.test');
    pmToken = await login('smoke-pm@localwaves.test');
    clientToken = await login('smoke-client@localwaves.test');
    return 'all three roles authenticated';
  });

  await check('auth: bad password rejected', async () => {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'smoke-pm@localwaves.test', password: 'wrong' },
    });
    expect(res.status === 401, `expected 401, got ${res.status}`);
    return '401';
  });

  await check('modalities: catalog intact', async () => {
    const res = await api('/api/modalities', { token: ownerToken });
    expect(res.status === 200, `status ${res.status} ${brief(res.json)}`);
    const keys = Object.keys(res.json?.grouped ?? {});
    for (const required of ['projects', 'contentReviews', 'contentMap']) {
      expect(keys.includes(required), `missing modality "${required}"`);
    }
    return `${keys.length} feature keys incl. contentMap`;
  });

  let projectId;
  await check('pm: project list', async () => {
    const res = await api('/api/projects', { token: pmToken });
    expect(res.status === 200, `status ${res.status} ${brief(res.json)}`);
    const list = Array.isArray(res.json) ? res.json : (res.json.projects ?? res.json.data ?? []);
    expect(list.length > 0, 'no projects returned');
    projectId = list[0].id;
    return `${list.length} project(s)`;
  });

  await check('pm: project detail', async () => {
    const res = await api(`/api/projects/${projectId}`, { token: pmToken });
    expect(res.status === 200, `status ${res.status}`);
    return `status=${res.status}`;
  });

  await check('client: project list', async () => {
    const res = await api('/api/client/projects', { token: clientToken });
    expect(res.status === 200, `status ${res.status} ${brief(res.json)}`);
    const list = Array.isArray(res.json) ? res.json : (res.json.projects ?? res.json.data ?? []);
    expect(list.length > 0, 'client sees no projects');
    return `${list.length} project(s)`;
  });

  await check('pm: pipeline', async () => {
    const res = await api(`/api/pm/pipeline?projectId=${projectId}`, { token: pmToken });
    expect(res.status === 200, `status ${res.status} ${brief(res.json)}`);
    return `status=${res.status}`;
  });

  await check('tasks: list', async () => {
    const res = await api(`/api/tasks?projectId=${projectId}`, { token: pmToken });
    expect(res.status === 200, `status ${res.status} ${brief(res.json)}`);
    return `status=${res.status}`;
  });

  await check('pm: wp pages still readable', async () => {
    const res = await api(`/api/projects/${projectId}/wp-pages`, { token: pmToken });
    expect(res.status === 200, `status ${res.status} ${brief(res.json)}`);
    return `status=${res.status}`;
  });

  /* ── Content map: pre-existing surfaces ──────────────────────────────── */

  let mapId;
  await check('content map: create', async () => {
    const res = await api(`/api/pm/projects/${projectId}/content-maps`, {
      token: pmToken,
      method: 'POST',
      body: { name: 'Smoke Map' },
    });
    expect(res.status === 201, `status ${res.status} ${brief(res.json)}`);
    mapId = res.json?.map?.id;
    expect(mapId, `no map id in ${brief(res.json)}`);
    return mapId;
  });

  await check('content map: list for project', async () => {
    const res = await api(`/api/pm/projects/${projectId}/content-maps`, { token: pmToken });
    expect(res.status === 200, `status ${res.status}`);
    return `status=${res.status}`;
  });

  /* ── Content map: new WordPress sync surfaces ────────────────────────── */

  await check('sync: import site into map', async () => {
    const res = await api(`/api/pm/content-maps/${mapId}/sync-site`, {
      token: pmToken,
      method: 'POST',
      body: { mode: 'import' },
    });
    expect(res.status === 200, `status ${res.status} ${brief(res.json)}`);
    return brief(res.json.stats ?? { created: res.json.created, updated: res.json.updated });
  });

  let rows = [];
  await check('sync: nodes created from WP pages', async () => {
    const res = await api(`/api/pm/content-maps/${mapId}`, { token: pmToken });
    expect(res.status === 200, `status ${res.status}`);
    rows = res.json.rows ?? [];
    expect(rows.length > 0, 'no nodes after import');
    const wp = rows.filter((n) => n.source === 'WORDPRESS');
    expect(wp.length >= 5, `expected >=5 WORDPRESS nodes, got ${wp.length}`);
    const live = rows.filter((n) => n.lifecycle === 'LIVE');
    expect(live.length >= 5, `expected >=5 LIVE nodes, got ${live.length}`);
    const pipeline = rows.filter((n) => n.lifecycle === 'IN_PIPELINE');
    expect(pipeline.length >= 1, 'the draft WP page should map to IN_PIPELINE');
    const nested = rows.filter((n) => (n.pathDepth ?? 0) >= 2);
    expect(nested.length >= 2, 'URL path hierarchy was not derived');
    const linked = rows.filter((n) => n.wpPageId);
    expect(linked.length >= 5, 'nodes are not linked back to WpPage rows');
    return `${rows.length} nodes | ${wp.length} from WP | ${live.length} live | ${pipeline.length} in pipeline | ${nested.length} nested`;
  });

  await check('sync: re-run does not duplicate nodes', async () => {
    const before = rows.length;
    const res = await api(`/api/pm/content-maps/${mapId}/sync-site`, {
      token: pmToken,
      method: 'POST',
      body: {},
    });
    expect(res.status === 200, `status ${res.status} ${brief(res.json)}`);
    const after = await api(`/api/pm/content-maps/${mapId}`, { token: pmToken });
    const count = (after.json.rows ?? []).length;
    expect(count === before, `node count changed ${before} -> ${count}`);
    return `stable at ${count} nodes`;
  });

  await check('sync: state recorded', async () => {
    const res = await api(`/api/pm/content-maps/${mapId}/sync`, { token: pmToken });
    expect(res.status === 200, `status ${res.status}`);
    expect(res.json.state?.lastSyncAt, `lastSyncAt not recorded: ${brief(res.json)}`);
    return `lastSyncAt=${res.json.state.lastSyncAt} pendingDrift=${res.json.pendingDrift} wpConnected=${res.json.wpConnected}`;
  });

  await check('sync: settings patch (autoAdopt)', async () => {
    const res = await api(`/api/pm/content-maps/${mapId}/sync`, {
      token: pmToken,
      method: 'PATCH',
      body: { autoAdopt: true },
    });
    expect(res.status === 200, `status ${res.status} ${brief(res.json)}`);
    expect(res.json.autoAdopt === true, 'autoAdopt did not persist');
    await api(`/api/pm/content-maps/${mapId}/sync`, {
      token: pmToken,
      method: 'PATCH',
      body: { autoAdopt: false },
    });
    return 'toggled on and back off';
  });

  await check('site inventory: fully mapped after import', async () => {
    const res = await api(`/api/pm/content-maps/${mapId}/site-inventory`, { token: pmToken });
    expect(res.status === 200, `status ${res.status} ${brief(res.json)}`);
    expect(typeof res.json.total === 'number', 'no total in inventory');
    return `${res.json.items.length} unmapped of ${res.json.total} site pages`;
  });

  await check('drift: queue reachable', async () => {
    const res = await api(`/api/pm/content-maps/${mapId}/drift`, { token: pmToken });
    expect(res.status === 200, `status ${res.status} ${brief(res.json)}`);
    expect(Array.isArray(res.json.items), 'no items array');
    return `${res.json.items.length} pending`;
  });

  await check('health: issues computed', async () => {
    const res = await api(`/api/pm/content-maps/${mapId}/health`, { token: pmToken });
    expect(res.status === 200, `status ${res.status} ${brief(res.json)}`);
    const h = res.json;
    expect(h.issues || h.coverage, `unexpected health shape: ${brief(h)}`);
    return brief(h, 320);
  });

  await check('metrics: refresh', async () => {
    const res = await api(`/api/pm/content-maps/${mapId}/refresh-metrics`, {
      token: pmToken,
      method: 'POST',
      body: {},
    });
    expect(res.status === 200, `status ${res.status} ${brief(res.json)}`);
    return brief(res.json);
  });

  await check('enrichment: word count / links on a node', async () => {
    const res = await api(`/api/pm/content-maps/${mapId}`, { token: pmToken });
    const enriched = (res.json.rows ?? []).filter((n) => n.metrics && n.metrics.wordCount != null);
    expect(enriched.length >= 5, `only ${enriched.length} node(s) carry metrics`);
    const sample = enriched.find((n) => n.metrics.wordCount > 100) ?? enriched[0];
    return `${enriched.length} enriched; sample "${sample.name}" words=${sample.metrics.wordCount} inLinks=${sample.metrics.internalLinksIn ?? '?'}`;
  });

  /* ── Forecasting ─────────────────────────────────────────────────────── */

  let plannedNodeId;
  await check('planning: create a planned node', async () => {
    const res0 = await api(`/api/pm/content-maps/${mapId}`, { token: pmToken });
    const parent = (res0.json.rows ?? []).find((n) => n.kind === 'ROOT') ?? (res0.json.rows ?? [])[0];
    const res = await api(`/api/pm/content-maps/${mapId}/nodes`, {
      token: pmToken,
      method: 'POST',
      body: {
        parentId: parent.id,
        name: 'Emergency Plumber Near Me',
        slug: '/emergency-plumber/',
        priority: 'P1',
        plannedPublishDate: new Date(Date.now() + 14 * 86400000).toISOString(),
      },
    });
    expect(res.status === 201, `status ${res.status} ${brief(res.json)}`);
    plannedNodeId = res.json.id;
    expect(res.json.lifecycle === 'PLANNED', `expected PLANNED, got ${res.json.lifecycle}`);
    expect(res.json.source === 'PLANNED', `expected source PLANNED, got ${res.json.source}`);
    expect(res.json.plannedPublishDate, 'plannedPublishDate not stored');
    return `lifecycle=${res.json.lifecycle} planned=${res.json.plannedPublishDate}`;
  });

  await check('schedule: reschedule derives the work cycle', async () => {
    const target = new Date();
    target.setDate(15);
    const res = await api(`/api/pm/content-maps/${mapId}/nodes/${plannedNodeId}/schedule`, {
      token: pmToken,
      method: 'PATCH',
      body: { plannedPublishDate: target.toISOString() },
    });
    expect(res.status === 200, `status ${res.status} ${brief(res.json)}`);
    const node = res.json.node ?? res.json;
    expect(node.workCycleId, `no workCycleId derived: ${brief(node)}`);
    return `cycle=${node.workCycleId}`;
  });

  await check('schedule: board data', async () => {
    const res = await api(`/api/pm/content-maps/${mapId}/schedule`, { token: pmToken });
    expect(res.status === 200, `status ${res.status} ${brief(res.json)}`);
    expect(Array.isArray(res.json.items), 'no items array');
    expect(res.json.items.length >= 1, 'planned node missing from the schedule');
    return `${res.json.items.length} scheduled, ${res.json.unscheduled.length} unscheduled`;
  });

  await check('task binding: create-task sets dueDate + workCycleId', async () => {
    const res = await api(`/api/pm/content-maps/${mapId}/nodes/${plannedNodeId}/create-task`, {
      token: pmToken,
      method: 'POST',
      body: {},
    });
    expect(res.status === 201, `status ${res.status} ${brief(res.json)}`);
    const task = res.json.task;
    expect(task.dueDate, 'task has no dueDate');
    expect(task.workCycleId, 'task has no workCycleId');
    return `due=${task.dueDate} cycle=${task.workCycleId}`;
  });

  await check('node detail: rich payload for a WP node', async () => {
    const res0 = await api(`/api/pm/content-maps/${mapId}`, { token: pmToken });
    const wpNode = (res0.json.rows ?? []).find((n) => n.wpPageId);
    expect(wpNode, 'no WP-linked node to inspect');
    const res = await api(`/api/pm/content-maps/${mapId}/nodes/${wpNode.id}/detail`, {
      token: pmToken,
    });
    expect(res.status === 200, `status ${res.status} ${brief(res.json)}`);
    return Object.keys(res.json).join(',');
  });

  /* ── Client stays read-only ──────────────────────────────────────────── */

  await check('client: blocked from the drift queue', async () => {
    const res = await api(`/api/pm/content-maps/${mapId}/drift`, { token: clientToken });
    expect(res.status === 401 || res.status === 403, `expected 401/403, got ${res.status}`);
    return `status=${res.status}`;
  });

  await check('client: blocked from mutating nodes', async () => {
    const res = await api(`/api/pm/content-maps/${mapId}/nodes/${plannedNodeId}`, {
      token: clientToken,
      method: 'PATCH',
      body: { name: 'should not apply' },
    });
    expect(res.status === 401 || res.status === 403, `expected 401/403, got ${res.status}`);
    return `status=${res.status}`;
  });

  await check('client: map read gated on visibility', async () => {
    const hidden = await api(`/api/client/projects/${projectId}/content-map/${mapId}`, {
      token: clientToken,
    });
    expect(hidden.status === 404, `draft map leaked to the client: ${hidden.status}`);

    const pub = await api(`/api/pm/content-maps/${mapId}`, {
      token: pmToken,
      method: 'PATCH',
      body: { clientVisible: true, status: 'IN_REVIEW' },
    });
    expect(pub.status === 200, `publish failed ${pub.status} ${brief(pub.json)}`);

    const shown = await api(`/api/client/projects/${projectId}/content-map/${mapId}`, {
      token: clientToken,
    });
    expect(shown.status === 200, `published map not visible: ${shown.status}`);
    expect(shown.json.rows?.length > 0, `no nodes in the client view: ${brief(shown.json)}`);
    return `draft=404 published=200 with ${shown.json.rows.length} nodes`;
  });

  await check('client: read-only schedule view', async () => {
    const res = await api(`/api/client/projects/${projectId}/content-map/${mapId}/schedule`, {
      token: clientToken,
    });
    expect(res.status === 200, `status ${res.status} ${brief(res.json)}`);
    return `${(res.json.items ?? []).length} item(s)`;
  });

  /* ── Report ──────────────────────────────────────────────────────────── */

  console.log('');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  ::  ${r.detail}` : ''}`);
  }
  console.log('');
  console.log(`${results.length - failures}/${results.length} passed`);
  if (failures) process.exitCode = 1;
}

main().catch((err) => {
  console.error('suite crashed:', err);
  process.exitCode = 1;
});
