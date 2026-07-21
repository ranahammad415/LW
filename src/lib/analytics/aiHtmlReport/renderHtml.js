/**
 * Render P2EzPay-style dark teal HTML performance report.
 * All AI / user-facing strings are escaped.
 */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escAttr(s) {
  return esc(s).replace(/\n/g, ' ');
}

function deltaHtml(delta, positiveMetric) {
  if (delta == null) return '<span class="kpi-delta neutral">—</span>';
  const d = Number(delta);
  // For position/bounce, negative delta is "up" (good)
  const good = positiveMetric === false ? d < 0 : d > 0;
  const cls = d === 0 ? 'neutral' : good ? 'up' : 'down';
  const arrow = d > 0 ? '▲' : d < 0 ? '↓' : '•';
  const sign = d > 0 ? '+' : '';
  return `<div class="kpi-delta ${cls}">${arrow} ${sign}${d}% vs prior</div>`;
}

function sourceTag(source, tag) {
  if (tag === 'context') return '<div class="tag tag-ctx">Context</div>';
  if (source === 'gsc') return '<div class="tag tag-gsc">GSC WIN</div>';
  if (source === 'ga4') return '<div class="tag tag-ga">GA4 WIN</div>';
  return '<div class="tag tag-ga">WIN</div>';
}

function cardClass(tag) {
  if (tag === 'win') return 'pos';
  if (tag === 'context') return 'ctx';
  return 'ga';
}

function formatVal(card) {
  const v = card.value;
  if (v == null) return '—';
  if (card.format === 'pct') return `${Number(v).toFixed(1)}%`;
  if (card.format === 'position') return Number(v).toFixed(2);
  if (card.format === 'rate') return `${Number(v).toFixed(2)}%`;
  if (typeof v === 'number' && Math.abs(v) >= 1000) {
    return v >= 10000 ? `${(v / 1000).toFixed(1)}K` : v.toLocaleString('en-US');
  }
  return typeof v === 'number' ? String(Math.round(v * 100) / 100) : esc(v);
}

/**
 * @param {{ facts: object, narrative: object }} opts
 */
export function renderPerformanceHtml({ facts, narrative }) {
  const brand = facts.brandName || 'Performance Report';
  const site = facts.websiteUrl || '';
  const rangeLabel = facts.range?.label || '';
  const prevLabel = facts.prevRange?.label || '';
  const sub = [site, rangeLabel, prevLabel ? `vs ${prevLabel}` : null].filter(Boolean).join(' · ');
  const sources = (facts.sources || []).join(' + ') || 'Analytics';
  const health = Math.max(0, Math.min(100, Number(facts.healthScore) || 50));
  const healthCls = health >= 55 ? 'g' : 'a';
  const healthLabel = narrative.healthLabel || (health >= 55 ? 'Positive impact leading' : 'Mixed period — review context');

  const kpiCards = (facts.kpiCards || [])
    .map((card, i) => {
      const note = narrative.kpiNotes?.[card.key];
      const lowerBetter = card.key === 'position' || card.key === 'bounceRate';
      return `<div class="kpi-card ${cardClass(card.tag)}" style="animation-delay:${0.04 + i * 0.05}s">
        ${sourceTag(card.source, card.tag)}
        <div class="kpi-label">${esc(card.label)}</div>
        <div class="kpi-val">${formatVal(card)}</div>
        ${deltaHtml(card.delta, !lowerBetter)}
        ${note ? `<div class="kpi-note">${esc(note)}</div>` : card.prevValue != null ? `<div class="kpi-note">Prior: ${esc(String(card.prevValue))}</div>` : ''}
      </div>`;
    })
    .join('\n');

  const achievements = (narrative.achievements || [])
    .map(
      (a) => `<div class="ach-card"><div class="ach-icon">${esc(a.icon || '📈')}</div><div class="ach-text"><span class="ach-stat">${esc(a.stat)}</span><h4>${esc(a.title)}</h4><p>${esc(a.detail)}</p></div></div>`
    )
    .join('\n');

  const execParas = (narrative.executiveSummary || []).map((p) => `<p>${esc(p)}</p>`).join('\n');

  const whatsWorking = (narrative.whatsWorking || [])
    .map(
      (t, i) =>
        `<div class="item"><div class="num num-g">${i + 1}</div><div class="item-txt">${esc(t)}</div></div>`
    )
    .join('\n');

  const actionItems = (narrative.actionItems || [])
    .map(
      (t, i) =>
        `<div class="item"><div class="num num-b">${i + 1}</div><div class="item-txt">${esc(t)}</div></div>`
    )
    .join('\n');

  const weakBlock =
    (narrative.weakContext || []).length > 0
      ? `<div class="sec-title amber-title">Context & Soft Metrics</div>
<div class="ctx-card">
  <h3>How to read the softer movements</h3>
  ${(narrative.weakContext || [])
    .map(
      (w) =>
        `<div class="ctx-item"><div class="ctx-dot"></div><div><strong>${esc(w.metric)}:</strong> ${esc(w.reason)}</div></div>`
    )
    .join('\n')}
</div>`
      : '';

  const tableKind = facts.pageTableKind;
  const pageRows = facts.pageRows || [];
  let tableHtml;
  if (tableKind === 'landing') {
    tableHtml = `<table>
      <thead><tr><th>Landing Page</th><th>Sessions</th><th>Users</th><th>Bounce</th><th>Status</th></tr></thead>
      <tbody>
        ${pageRows
          .map((r) => {
            const status =
              (r.sessions || 0) > 0
                ? '<span class="lbl-win">Active traffic</span>'
                : '<span class="lbl-ctx">Low activity</span>';
            const bounce =
              r.bounceRate == null
                ? '—'
                : `${(Number(r.bounceRate) <= 1 ? Number(r.bounceRate) * 100 : Number(r.bounceRate)).toFixed(1)}%`;
            return `<tr><td class="pg">${esc(r.page)}</td><td><strong>${r.sessions ?? 0}</strong></td><td>${r.users ?? 0}</td><td>${bounce}</td><td>${status}</td></tr>`;
          })
          .join('\n')}
      </tbody>
    </table>`;
  } else {
    tableHtml = `<table>
      <thead><tr><th>Query</th><th>Clicks</th><th>Impressions</th><th>CTR</th><th>Position</th><th>Status</th></tr></thead>
      <tbody>
        ${pageRows
          .map((r) => {
            let status = '<span class="lbl-ctx">Watch</span>';
            if ((r.clicks || 0) > 0 && (r.position || 99) <= 10) status = '<span class="lbl-win">Top 10 + clicks</span>';
            else if ((r.clicks || 0) > 0) status = '<span class="lbl-win">Earning clicks</span>';
            else if ((r.impressions || 0) > 50) status = '<span class="lbl-new">Impressions — CTR opportunity</span>';
            return `<tr><td class="pg">${esc(r.page)}</td><td><strong>${r.clicks ?? 0}</strong></td><td>${r.impressions ?? 0}</td><td>${r.ctr != null ? `${r.ctr}%` : '—'}</td><td>${r.position ?? '—'}</td><td>${status}</td></tr>`;
          })
          .join('\n')}
      </tbody>
    </table>`;
  }

  const chartPages = facts.chartPages || [];
  const chartChannels = facts.chartChannels || [];
  const chartDevices = facts.chartDevices || [];

  const pageChartTitle =
    tableKind === 'landing' ? 'Top Landing Pages — Sessions' : 'Top Queries — Clicks';
  const pageLabels = JSON.stringify(chartPages.map((p) => p.label));
  const pageCurrent = JSON.stringify(chartPages.map((p) => p.current));
  const pagePrev = JSON.stringify(chartPages.map((p) => p.previous || 0));
  const channelLabels = JSON.stringify(chartChannels.map((c) => `${c.label} (${c.value})`));
  const channelValues = JSON.stringify(chartChannels.map((c) => c.value));
  const deviceLabels = JSON.stringify(chartDevices.map((d) => d.label));
  const deviceCurrent = JSON.stringify(chartDevices.map((d) => d.current));

  const channelColors = JSON.stringify([
    '#14b8a6',
    '#3b82f6',
    '#10b981',
    '#f59e0b',
    '#6b7280',
    '#06b6d4',
    '#8b5cf6',
    '#ef4444',
  ]);

  const title = `${esc(brand)} — SEO Performance Report`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#08100a;--card:#0d1a10;--card2:#112214;--border:#1a3520;
  --teal:#14b8a6;--green:#10b981;--cyan:#06b6d4;--blue:#3b82f6;
  --amber:#f59e0b;--red:#ef4444;--text:#f1f5f9;--muted:#6b7280;--muted2:#9ca3af;
}
body{background:var(--bg);color:var(--text);font-family:'Inter',sans-serif}
.header{background:linear-gradient(135deg,#040a05 0%,#0c2a1a 45%,#040a05 100%);border-bottom:1px solid var(--border);padding:30px 48px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px}
.logo-block{display:flex;align-items:center;gap:16px}
.logo-icon{width:54px;height:54px;background:linear-gradient(135deg,var(--teal),var(--blue));border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0}
.eyebrow{font-size:11px;color:#5eead4;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;margin-bottom:5px}
.header h1{font-size:27px;font-weight:900;background:linear-gradient(90deg,#5eead4,var(--blue));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header .sub{font-size:13px;color:var(--muted2);margin-top:4px}
.header-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.badge{background:rgba(20,184,166,.15);border:1px solid rgba(20,184,166,.35);color:#5eead4;padding:6px 14px;border-radius:20px;font-size:12px;font-weight:600}
.btn-pdf{background:linear-gradient(135deg,#0d9488,#2563eb);color:#fff;border:none;padding:10px 22px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer}
.win-banner{background:linear-gradient(135deg,rgba(16,185,129,.12),rgba(20,184,166,.07));border:1px solid rgba(16,185,129,.3);border-left:4px solid var(--green);margin:22px 48px 0;padding:16px 22px;border-radius:10px;font-size:13px;color:#a7f3d0;line-height:1.75}
.win-banner strong{color:#6ee7b7}
.main{padding:28px 48px 72px;max-width:1320px;margin:0 auto}
.sec-title{font-size:10.5px;font-weight:800;color:#5eead4;letter-spacing:2.5px;text-transform:uppercase;margin-bottom:18px;display:flex;align-items:center;gap:10px}
.sec-title::after{content:'';flex:1;height:1px;background:var(--border)}
.sec-title.green-title{color:var(--green)}
.sec-title.amber-title{color:var(--amber)}
.exec{background:linear-gradient(135deg,rgba(20,184,166,.09),rgba(16,185,129,.05));border:1px solid rgba(20,184,166,.2);border-radius:15px;padding:28px 32px;margin-bottom:34px}
.exec h2{font-size:18px;font-weight:800;color:#5eead4;margin-bottom:13px}
.exec p{font-size:14px;line-height:1.85;color:#ccfbf1;margin-bottom:12px}
.exec p:last-child{margin-bottom:0}
.score-bar-wrap{background:var(--card);border:1px solid rgba(16,185,129,.28);border-radius:13px;padding:20px 26px;margin-bottom:30px;display:flex;align-items:center;gap:22px;flex-wrap:wrap}
.score-label{font-size:13px;font-weight:700;color:var(--muted2);min-width:120px}
.score-pct{font-size:18px;font-weight:900}
.score-pct.g{color:var(--green)}.score-pct.a{color:var(--amber)}
.ach-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(265px,1fr));gap:15px;margin-bottom:34px}
.ach-card{background:var(--card);border:1px solid rgba(16,185,129,.2);border-radius:13px;padding:18px;display:flex;gap:13px;align-items:flex-start}
.ach-icon{width:42px;height:42px;border-radius:10px;background:linear-gradient(135deg,var(--green),var(--teal));display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
.ach-stat{font-size:19px;font-weight:900;color:var(--green);display:block;margin:2px 0 4px}
.ach-text h4{font-size:13px;font-weight:700;margin-bottom:4px}
.ach-text p{font-size:12px;color:var(--muted2);line-height:1.6}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:13px;margin-bottom:34px}
.kpi-card{background:var(--card);border:1px solid var(--border);border-radius:13px;padding:18px 20px;position:relative;overflow:hidden;opacity:0;animation:rise .5s ease forwards}
.kpi-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:13px 13px 0 0}
.kpi-card.pos::before{background:linear-gradient(90deg,var(--green),var(--teal))}
.kpi-card.ga::before{background:linear-gradient(90deg,var(--teal),var(--blue))}
.kpi-card.ctx::before{background:linear-gradient(90deg,var(--amber),#fb923c)}
.tag{font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:2px 6px;border-radius:4px;display:inline-block;margin-bottom:8px}
.tag-gsc{background:rgba(16,185,129,.14);color:#6ee7b7}
.tag-ga{background:rgba(20,184,166,.15);color:#5eead4}
.tag-ctx{background:rgba(245,158,11,.13);color:var(--amber)}
.kpi-label{font-size:11px;color:var(--muted2);font-weight:500;text-transform:uppercase;letter-spacing:.7px;margin-bottom:7px}
.kpi-val{font-size:27px;font-weight:900;line-height:1;margin-bottom:8px}
.kpi-delta{font-size:12px;font-weight:700}
.up{color:var(--green)}.down{color:var(--amber)}.neutral{color:var(--muted2)}
.kpi-note{font-size:11px;color:var(--muted);margin-top:4px}
.charts-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:34px}
.chart-full{grid-column:1/-1}
.chart-card{background:var(--card);border:1px solid var(--border);border-radius:13px;padding:22px}
.chart-card h3{font-size:13.5px;font-weight:700;margin-bottom:17px}
.chart-card canvas{max-height:260px}
.tbl-card{background:var(--card);border:1px solid rgba(16,185,129,.2);border-radius:13px;padding:22px;margin-bottom:26px;overflow-x:auto}
.tbl-card h3{font-size:14px;font-weight:700;margin-bottom:4px}
.tbl-card p{font-size:12px;color:var(--muted2);margin-bottom:17px;line-height:1.6}
table{width:100%;border-collapse:collapse;font-size:13px}
thead th{text-align:left;padding:9px 11px;font-size:10px;font-weight:700;color:var(--muted2);text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid var(--border)}
tbody tr{border-bottom:1px solid rgba(255,255,255,.04)}
tbody td{padding:9px 11px;vertical-align:middle}
.pg{color:#5eead4;font-size:12px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lbl-win{background:rgba(16,185,129,.16);color:#6ee7b7;font-size:10px;padding:2px 6px;border-radius:4px}
.lbl-new{background:rgba(6,182,212,.14);color:var(--cyan);font-size:10px;padding:2px 6px;border-radius:4px}
.lbl-ctx{background:rgba(245,158,11,.13);color:var(--amber);font-size:10px;padding:2px 6px;border-radius:4px}
.ctx-card{background:var(--card);border:1px solid rgba(245,158,11,.22);border-radius:13px;padding:26px;margin-bottom:30px}
.ctx-card h3{font-size:15px;font-weight:800;color:var(--amber);margin-bottom:16px}
.ctx-item{display:flex;gap:13px;margin-bottom:14px;font-size:13px;color:#cbd5e1;line-height:1.7}
.ctx-dot{width:8px;height:8px;border-radius:50%;background:var(--amber);flex-shrink:0;margin-top:7px}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:34px}
.insight-card{background:var(--card);border:1px solid var(--border);border-radius:13px;padding:24px}
.insight-card h3{font-size:14px;font-weight:800;margin-bottom:16px}
.item{display:flex;gap:12px;margin-bottom:14px;align-items:flex-start}
.num{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;flex-shrink:0;margin-top:1px}
.num-g{background:linear-gradient(135deg,var(--green),var(--teal));color:#fff}
.num-b{background:linear-gradient(135deg,var(--teal),var(--blue));color:#fff}
.item-txt{font-size:13px;color:#d1d5db;line-height:1.65}
.conclusion{background:linear-gradient(135deg,rgba(20,184,166,.09),rgba(16,185,129,.06));border:1px solid rgba(94,234,212,.22);border-radius:13px;padding:26px 30px;margin-bottom:8px}
.conclusion h3{font-size:15px;font-weight:800;color:#5eead4;margin-bottom:12px}
.conclusion p{font-size:13.5px;line-height:1.85;color:#ccfbf1}
.method{background:var(--card2);border:1px solid var(--border);border-radius:13px;padding:18px 24px;font-size:12px;color:var(--muted2);line-height:1.7;margin-top:24px;text-align:center}
.footer{text-align:center;padding:20px;font-size:12px;color:var(--muted);border-top:1px solid var(--border)}
@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
@media(max-width:900px){.header,.main{padding:18px}.win-banner{margin:12px 18px 0}.charts-grid,.two-col{grid-template-columns:1fr}.kpi-grid{grid-template-columns:repeat(2,1fr)}}
@media print{body{background:#fff;color:#111}.header,.win-banner,.exec,.kpi-card,.ach-card,.chart-card,.tbl-card,.insight-card,.conclusion,.ctx-card,.method{break-inside:avoid}}
</style>
</head>
<body>

<div class="header">
  <div class="logo-block">
    <div class="logo-icon">📊</div>
    <div>
      <div class="eyebrow">SEO Performance Report</div>
      <h1>${esc(brand)}</h1>
      <div class="sub">${esc(sub)}</div>
    </div>
  </div>
  <div class="header-right">
    <span class="badge">${esc(sources)}</span>
    <button class="btn-pdf" onclick="window.print()">⬇ Download PDF</button>
  </div>
</div>

${
  narrative.winBanner
    ? `<div class="win-banner">🏆 <strong>Highlights:</strong> ${esc(narrative.winBanner)}</div>`
    : ''
}

<div class="main">

<div class="sec-title">Performance Health</div>
<div class="score-bar-wrap">
  <div><div class="score-label">Overall Performance</div><div style="font-size:12px;color:var(--muted2)">${esc(healthLabel)}</div></div>
  <div style="flex:1;min-width:220px">
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted2);margin-bottom:6px"><span>Positive Impact</span></div>
    <div style="height:16px;border-radius:20px;overflow:hidden;display:flex;gap:2px">
      <div style="width:${health}%;background:linear-gradient(90deg,var(--green),var(--teal));border-radius:20px 0 0 20px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff">${health}%</div>
    </div>
  </div>
  <div style="text-align:right"><div class="score-pct ${healthCls}">${health}/100</div></div>
</div>

<div class="exec">
  <h2>📋 Executive Summary</h2>
  ${execParas}
</div>

${
  achievements
    ? `<div class="sec-title green-title">🏆 Key Achievements</div><div class="ach-grid">${achievements}</div>`
    : ''
}

<div class="sec-title">Performance Snapshot${prevLabel ? ` — vs prior window` : ''}</div>
<div class="kpi-grid">
${kpiCards}
</div>

<div class="sec-title green-title">Visual Performance Trends</div>
<div class="charts-grid">
  <div class="chart-card chart-full"><h3>📈 ${esc(pageChartTitle)}</h3><canvas id="pageChart"></canvas></div>
  ${chartChannels.length ? `<div class="chart-card"><h3>📊 Sessions by Channel</h3><canvas id="channelChart"></canvas></div>` : ''}
  ${chartDevices.length ? `<div class="chart-card"><h3>🖥️ Sessions by Device</h3><canvas id="deviceChart"></canvas></div>` : ''}
</div>

<div class="sec-title green-title">${tableKind === 'landing' ? 'Landing Page Performance' : 'Query Performance'}</div>
<div class="tbl-card">
  <h3>${tableKind === 'landing' ? 'Top landing pages in this period' : 'Top queries by impressions'}</h3>
  <p>Status labels highlight wins and opportunities. Soft rows are context for next-period optimization.</p>
  ${tableHtml || '<p>No page/query rows available for this period.</p>'}
</div>

${weakBlock}

<div class="sec-title green-title">🚀 Opportunities & Next Steps</div>
<div class="two-col">
  <div class="insight-card">
    <h3>✅ What's Working — Prioritize & Compound</h3>
    ${whatsWorking || '<div class="item-txt">Continue monitoring core KPIs and compound proven channels.</div>'}
  </div>
  <div class="insight-card">
    <h3>🚀 Action Items</h3>
    ${actionItems || '<div class="item-txt">Review underperforming pages for CTR and content freshness.</div>'}
  </div>
</div>

<div class="conclusion">
  <h3>✅ Conclusion</h3>
  <p>${esc(narrative.conclusion || '')}</p>
</div>

<div class="method">
  <strong>Prepared:</strong> AI performance report · ${esc(rangeLabel)} · Sources: ${esc(sources)}
</div>

</div>
<div class="footer">${esc(brand)}${site ? ` · ${esc(site)}` : ''} | Confidential — For Client Use Only</div>

<script>
Chart.defaults.color='#6b7280';Chart.defaults.borderColor='#1a3520';
(function(){
  var pageLabels=${pageLabels};
  var pageCurrent=${pageCurrent};
  var pagePrev=${pagePrev};
  var hasPrev=pagePrev.some(function(v){return v>0;});
  var pageEl=document.getElementById('pageChart');
  if(pageEl&&pageLabels.length){
    new Chart(pageEl,{type:'bar',data:{labels:pageLabels,datasets:[{label:'Current',data:pageCurrent,backgroundColor:'rgba(20,184,166,.85)',borderRadius:6}].concat(hasPrev?[{label:'Prior',data:pagePrev,backgroundColor:'rgba(59,130,246,.45)',borderRadius:6}]:[])},options:{responsive:true,plugins:{legend:{position:'top'}},scales:{x:{grid:{color:'#1a3520'},ticks:{maxRotation:30,font:{size:10}}},y:{grid:{color:'#1a3520'},beginAtZero:true}}}});
  }
  var chEl=document.getElementById('channelChart');
  if(chEl){
    new Chart(chEl,{type:'doughnut',data:{labels:${channelLabels},datasets:[{data:${channelValues},backgroundColor:${channelColors},borderWidth:2,borderColor:'#0d1a10'}]},options:{responsive:true,plugins:{legend:{position:'right',labels:{padding:10,font:{size:11}}}}}});
  }
  var dvEl=document.getElementById('deviceChart');
  if(dvEl){
    new Chart(dvEl,{type:'bar',data:{labels:${deviceLabels},datasets:[{label:'Sessions',data:${deviceCurrent},backgroundColor:'rgba(20,184,166,.85)',borderRadius:6}]},options:{responsive:true,plugins:{legend:{position:'top'}},scales:{x:{grid:{color:'#1a3520'}},y:{grid:{color:'#1a3520'},beginAtZero:true}}}});
  }
})();
</script>
</body>
</html>`;
}

/**
 * Safe filename for download.
 */
export function buildReportFileName(brandName, start, end) {
  const slug = String(brandName || 'report')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${slug || 'report'}-seo-${start || 'start'}-to-${end || 'end'}.html`;
}
