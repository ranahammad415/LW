#!/usr/bin/env node
// READ-ONLY diagnostic: compare Agency OS content reviews with the live
// WordPress pipeline state for each project. Writes nothing to the DB or WP.
//
//   node scripts/diagnose-pipeline-sync.mjs                 # all open reviews
//   node scripts/diagnose-pipeline-sync.mjs "Sheboygan"     # filter by title
//
// For every OS row it prints the OS status vs the WP status and flags:
//   WP_FETCH_FAILED  - the server cannot read the WP pipeline API (firewall/WAF, key, plugin)
//   MISSING_IN_WP    - OS row has no matching WP pipeline id
//   MISMATCH         - WP moved on but OS did not (webhooks + 5-min sync not applying)
//   DUPLICATES       - several WP pipelines exist for the same post (client link may update another one)
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const titleFilter = (process.argv[2] || '').toLowerCase();

async function fetchWpPipelines(project) {
  const base = project.wpUrl.replace(/\/$/, '');
  const items = [];
  for (let page = 1, total = 1; page <= total && page <= 40; page++) {
    const res = await fetch(`${base}/wp-json/lwa/v1/pipeline?page=${page}&per_page=100`, {
      headers: {
        'X-LWA-API-Key': project.wpApiKey,
        Accept: 'application/json',
        'User-Agent': 'Localwaves-AgencyOS/1.0 (+https://localwaves; pipeline diagnose)',
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 160).replace(/\s+/g, ' ');
      throw new Error(`HTTP ${res.status} ${text}`);
    }
    const json = await res.json();
    const batch = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    items.push(...batch);
    total = Math.max(1, Number(json?.total_pages) || 1);
    if (batch.length === 0) break;
  }
  return items;
}

try {
  const reviews = await prisma.wpContentReview.findMany({
    where: { isPublished: false },
    select: {
      wpPipelineId: true, wpPostId: true, postTitle: true, status: true,
      clientDecision: true, clientReviewedAt: true, pmReviewedAt: true,
      lastEventType: true, updatedAt: true,
      project: { select: { id: true, name: true, wpUrl: true, wpApiKey: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });
  const rows = reviews.filter((r) => !titleFilter || (r.postTitle || '').toLowerCase().includes(titleFilter));
  console.log(`OS open reviews checked: ${rows.length}\n`);

  const byProject = new Map();
  for (const r of rows) {
    if (!r.project?.wpUrl || !r.project?.wpApiKey) continue;
    if (!byProject.has(r.project.id)) byProject.set(r.project.id, { project: r.project, rows: [] });
    byProject.get(r.project.id).rows.push(r);
  }

  const summary = { WP_FETCH_FAILED: 0, MISSING_IN_WP: 0, MISMATCH: 0, DUPLICATES: 0, OK: 0 };
  for (const { project, rows: projectRows } of byProject.values()) {
    console.log(`== ${project.name} (${project.wpUrl})`);
    let wp;
    try {
      wp = await fetchWpPipelines(project);
    } catch (err) {
      summary.WP_FETCH_FAILED += projectRows.length;
      console.log(`   WP_FETCH_FAILED: ${err.message}\n`);
      continue;
    }
    const byId = new Map(wp.map((p) => [Number(p.id), p]));
    const byPost = new Map();
    for (const p of wp) {
      const k = Number(p.postId);
      if (!byPost.has(k)) byPost.set(k, []);
      byPost.get(k).push(p);
    }
    for (const r of projectRows) {
      const w = byId.get(r.wpPipelineId);
      const flags = [];
      if (!w) flags.push('MISSING_IN_WP');
      else if (String(w.status) !== String(r.status)) flags.push('MISMATCH');
      const siblings = byPost.get(Number(w?.postId ?? r.wpPostId)) || [];
      if (siblings.length > 1) flags.push('DUPLICATES');
      if (!flags.length) flags.push('OK');
      for (const f of flags) summary[f]++;
      console.log(`   [${flags.join(',')}] "${r.postTitle}" pipeline #${r.wpPipelineId}`);
      console.log(`      OS: ${r.status} (last event ${r.lastEventType || '-'}, clientReviewedAt ${r.clientReviewedAt || '-'})`);
      if (w) console.log(`      WP: ${w.status} (clientDecision ${w.clientDecision || '-'}, clientReviewedAt ${w.clientReviewedAt || '-'}, updatedAt ${w.updatedAt || '-'})`);
      if (siblings.length > 1) {
        console.log(`      WP pipelines for this post: ${siblings.map((s) => `#${s.id}=${s.status}`).join(', ')}`);
      }
    }
    console.log('');
  }
  console.log('SUMMARY', JSON.stringify(summary));
} finally {
  await prisma.$disconnect();
}
