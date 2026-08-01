/**
 * Formal Local Waves SEO & Performance Report HTML (print / Playwright PDF).
 * Design lock: navy #003087, gold #FFB81C, cover / fold+01 / sections / conclusion.
 * Long sections are chunked onto continuation pages (no overflow clipping).
 */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Approx printable body lines that fit a section page under header+footer. */
const SECTION_PAGE_LINES = 36;
/** Approx lines available under fold on exec page. */
const EXEC_FIRST_PAGE_LINES = 18;
const EXEC_CONT_PAGE_LINES = 40;
const CHARS_PER_LINE = 92;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function lineCost(text, min = 1) {
  const len = String(text || '').trim().length;
  if (!len) return 0;
  return Math.max(min, Math.ceil(len / CHARS_PER_LINE));
}

function normalizeAiContent(raw) {
  const ac = raw && typeof raw === 'object' ? raw : {};
  if (!ac.executive && (ac.executiveSummary || ac.seoPerformance)) {
    return {
      coverSummary: ac.executiveSummary || '',
      preparedBy: ac.preparedBy || 'Local Waves',
      executive: {
        strategicApproach: ac.executiveSummary || '',
        performanceGains: ac.seoPerformance || '',
        localVisibility: '',
        technicalHealth: '',
        nextSteps: Array.isArray(ac.highlights) ? ac.highlights.join(' ') : '',
      },
      sections: Array.isArray(ac.sections) ? ac.sections : [],
      conclusion: ac.conclusion || ac.seoPerformance || '',
    };
  }
  return {
    coverSummary: ac.coverSummary || '',
    preparedBy: ac.preparedBy || 'Local Waves',
    executive: {
      strategicApproach: ac.executive?.strategicApproach || '',
      performanceGains: ac.executive?.performanceGains || '',
      localVisibility: ac.executive?.localVisibility || '',
      technicalHealth: ac.executive?.technicalHealth || '',
      nextSteps: ac.executive?.nextSteps || '',
    },
    sections: Array.isArray(ac.sections) ? ac.sections : [],
    conclusion: ac.conclusion || '',
  };
}

function localWavesMark(size = 36) {
  return `<svg class="lw-mark" width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true">
  <circle cx="24" cy="18" r="9" fill="#FFB81C"/>
  <path d="M24 9c-5 0-9 4-9 9 0 7 9 17 9 17s9-10 9-17c0-5-4-9-9-9zm0 12.2a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4z" fill="#003087"/>
  <path d="M10 38c4.5-3.2 9.2-4.8 14-4.8S33.5 34.8 38 38" fill="none" stroke="#22c55e" stroke-width="2.4" stroke-linecap="round"/>
  <path d="M14 42c3.5-2.2 6.9-3.2 10-3.2s6.5 1 10 3.2" fill="none" stroke="#16a34a" stroke-width="2" stroke-linecap="round" opacity=".85"/>
</svg>`;
}

function localWavesWordmark() {
  return `<div class="lw-wordmark" aria-label="Local Waves">
  <span class="lw-local">LOCAL</span>
  ${localWavesMark(28)}
  <span class="lw-waves">WAVES</span>
</div>`;
}

function iconEmail() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6h16v12H4V6z" stroke="#fff" stroke-width="2"/><path d="M4 7l8 6 8-6" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function iconPhone() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 3h3l2 5-2 1a12 12 0 0 0 5 5l1-2 5 2v3a2 2 0 0 1-2 2A15 15 0 0 1 5 5a2 2 0 0 1 2-2z" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>`;
}
function iconPin() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 21s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z" stroke="#fff" stroke-width="2"/><circle cx="12" cy="9" r="2.5" fill="#fff"/></svg>`;
}

function pageFooter(footerLabel) {
  return `<div class="page-footer footer-left"><span>${esc(footerLabel)}</span></div>`;
}

function renderUnits(units) {
  return units
    .map((u) => {
      if (u.type === 'dash-heading') return `<h3 class="exec-sub dashed">– ${esc(u.text)} –</h3>`;
      if (u.type === 'subhead') return `<p class="subhead">--- ${esc(u.text)} ---</p>`;
      if (u.type === 'p') return `<p class="body">${esc(u.text)}</p>`;
      if (u.type === 'li') return `<ul class="bullets single"><li>${esc(u.text)}</li></ul>`;
      if (u.type === 'value') {
        return `<p class="value"><strong>VALUE DELIVERED:</strong> ${esc(u.text)}</p>`;
      }
      return '';
    })
    .join('');
}

function paginateUnits(units, firstCap, contCap) {
  const pages = [];
  let bucket = [];
  let used = 0;
  let cap = firstCap;
  for (const unit of units) {
    const cost = unit.cost || 1;
    if (bucket.length && used + cost > cap) {
      pages.push(bucket);
      bucket = [];
      used = 0;
      cap = contCap;
    }
    if (cost > cap && !bucket.length) {
      pages.push([unit]);
      cap = contCap;
      continue;
    }
    bucket.push(unit);
    used += cost;
  }
  if (bucket.length) pages.push(bucket);
  return pages.length ? pages : [[]];
}

export function buildExecPagination(executive, footerLabel) {
  const blocks = [
    ['Strategic Approach', executive.strategicApproach],
    ['Performance Gains & Search Visibility', executive.performanceGains],
    ['Local Visibility Impact & Trust Building', executive.localVisibility],
    ['Technical Health & Site Performance', executive.technicalHealth],
    ['Next Steps', executive.nextSteps],
  ].filter(([, text]) => text && String(text).trim());

  const units = [];
  for (const [label, text] of blocks) {
    units.push({ type: 'dash-heading', text: label, cost: 2 });
    units.push({ type: 'p', text, cost: lineCost(text, 2) + 1 });
  }
  if (!units.length) {
    units.push({ type: 'p', text: 'No executive summary content.', cost: 2 });
  }

  const pages = paginateUnits(units, EXEC_FIRST_PAGE_LINES, EXEC_CONT_PAGE_LINES);
  const firstHtml = renderUnits(pages[0] || []);
  const contHtml = pages
    .slice(1)
    .map(
      (pageUnits) => `
<section class="page content-page">
  <div class="content-pad">
    <h2 class="exec-title cont">Executive Summary <span class="cont-label">(continued)</span></h2>
    <div class="exec-rule"></div>
    ${renderUnits(pageUnits)}
    ${pageFooter(footerLabel)}
  </div>
</section>`,
    )
    .join('\n');

  return { firstHtml, contHtml, pageCount: pages.length };
}

export function sectionPagesHtml(sections, footerLabel) {
  return sections
    .map((sec) => {
      const num = pad2(sec.number ?? 0);
      const title = String(sec.title || 'SECTION').toUpperCase();
      const units = [];
      if (sec.intro) {
        units.push({ type: 'p', text: sec.intro, cost: lineCost(sec.intro, 2) + 1 });
      }
      for (const block of sec.blocks || []) {
        if (block.heading) {
          units.push({ type: 'subhead', text: block.heading, cost: 2 });
        }
        for (const bullet of block.bullets || []) {
          if (!String(bullet || '').trim()) continue;
          units.push({ type: 'li', text: bullet, cost: lineCost(bullet, 1) + 0.5 });
        }
      }
      if (sec.valueDelivered) {
        units.push({
          type: 'value',
          text: sec.valueDelivered,
          cost: lineCost(sec.valueDelivered, 2) + 2,
        });
      }
      if (!units.length) {
        units.push({ type: 'p', text: 'No work recorded for this section.', cost: 2 });
      }

      const pages = paginateUnits(units, SECTION_PAGE_LINES - 5, SECTION_PAGE_LINES - 4);

      return pages
        .map((pageUnits, idx) => {
          const continued = idx > 0;
          return `
<section class="page content-page section-page">
  <div class="content-pad">
    <div class="sec-head">
      <div class="num-box">${num}</div>
      <div>
        <h2 class="sec-title">${esc(title)}${continued ? ' <span class="cont-label">(continued)</span>' : ''}</h2>
        <div class="sec-rule"></div>
      </div>
    </div>
    ${renderUnits(pageUnits)}
    ${pageFooter(footerLabel)}
  </div>
</section>`;
        })
        .join('\n');
    })
    .join('\n');
}

/**
 * @param {object} opts
 */
export function renderFormalReportHtml(opts) {
  const {
    aiContent,
    clientName,
    websiteUrl,
    month,
    year,
    clientLogoDataUrl = null,
    foldDataUrl = null,
    agency = {},
  } = opts;

  const content = normalizeAiContent(aiContent);
  const monthName = MONTHS[(month || 1) - 1] || '';
  const monthYear = `${monthName.toUpperCase()} ${year}`;
  const footerLabel = `${year} ${monthName} - SEO & Performance Report`;
  const displayUrl = (websiteUrl || '').replace(/^https?:\/\//i, '') || '';

  const { firstHtml: execFirstHtml, contHtml: execContHtml } = buildExecPagination(
    content.executive,
    footerLabel,
  );

  const logoImg = clientLogoDataUrl
    ? `<img class="client-logo" src="${clientLogoDataUrl}" alt="${esc(clientName)}" />`
    : `<div class="client-logo-text">${esc(clientName)}</div>`;

  const foldBlock = foldDataUrl
    ? `<img class="fold-img" src="${foldDataUrl}" alt="Website preview" />`
    : `<div class="fold-placeholder">
        <div class="fold-placeholder-chrome">
          <span class="dot"></span><span class="dot"></span><span class="dot"></span>
          <span class="fold-url">${esc(displayUrl || 'website')}</span>
        </div>
        <div class="fold-placeholder-inner">
          <div class="fold-placeholder-title">${esc(clientName)}</div>
          <div class="fold-placeholder-hint">Upload a website fold screenshot in Report assets for the live homepage preview.</div>
        </div>
      </div>`;

  const agencyEmail = agency.email || '';
  const agencyPhone = agency.phone || '';
  const agencyAddress = agency.address || '';
  const agencyLogo = agency.logoDataUrl
    ? `<img class="agency-logo" src="${agency.logoDataUrl}" alt="${esc(agency.agencyName || 'Local Waves')}" />`
    : localWavesWordmark();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${esc(clientName)} — SEO & Performance Report — ${esc(monthYear)}</title>
<style>
  @page { size: Letter; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
    color: #333;
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .page {
    width: 8.5in;
    height: 11in;
    min-height: 11in;
    max-height: 11in;
    position: relative;
    overflow: hidden;
    page-break-after: always;
    break-after: page;
    background: #fff;
  }
  .page:last-child { page-break-after: auto; break-after: auto; }
  .content-pad {
    padding: 0.55in 0.75in 0.7in;
    height: 100%;
    position: relative;
  }

  .cover { background: #fff; padding: 0.5in 0.7in 0.45in 0.95in; }
  .cover-sidebar {
    position: absolute; left: 0; top: 0.7in; width: 0.3in; height: 7.6in;
    background: #003087;
    clip-path: polygon(0 0.15in, 100% 0, 100% calc(100% - 0.2in), 0 100%);
  }
  .cover-gold-top {
    position: absolute; left: 0; top: 0.42in; width: 0.55in; height: 0.38in;
    background: #FFB81C;
    clip-path: polygon(0 35%, 100% 0, 100% 100%, 0 100%);
  }
  .cover-gold-bot {
    position: absolute; left: 0; bottom: 1.9in; width: 0.3in; height: 0.45in;
    background: #FFB81C;
    clip-path: polygon(0 0, 100% 20%, 100% 100%, 0 80%);
  }
  .brand-row { display: flex; align-items: center; gap: 8px; margin-bottom: 0.48in; }
  .lw-wordmark { display: inline-flex; align-items: center; gap: 6px; }
  .lw-local { font-size: 17px; font-weight: 800; color: #003087; letter-spacing: 1px; }
  .lw-waves { font-size: 17px; font-weight: 800; color: #2b6cb0; letter-spacing: 1px; }
  .lw-mark { display: block; flex-shrink: 0; }
  .cover-month {
    font-size: 44px; font-weight: 800; color: #FFB81C; letter-spacing: 1px;
    line-height: 1.02; margin-bottom: 4px;
  }
  .cover-title {
    font-size: 28px; font-weight: 800; color: #003087; letter-spacing: 0.5px;
    line-height: 1.12; margin-bottom: 0.28in;
  }
  .cover-summary {
    font-size: 12.5px; line-height: 1.65; color: #555; max-width: 6.2in;
    margin-bottom: 0.38in;
  }
  .prep-band {
    background: #ececec; margin: 0 -0.7in 0 -0.95in; padding: 0.3in 0.7in 0.3in 0.95in;
    display: flex; justify-content: space-between; align-items: center; gap: 24px;
    min-height: 1.3in;
  }
  .prep-labels { font-size: 13px; color: #003087; }
  .prep-labels strong { display: block; margin-bottom: 2px; }
  .prep-labels .val { color: #444; font-weight: 500; margin-bottom: 10px; }
  .client-logo { max-height: 72px; max-width: 200px; object-fit: contain; }
  .client-logo-text { font-size: 15px; font-weight: 800; color: #003087; text-align: right; max-width: 220px; }
  .cover-url {
    margin-top: 0.5in; font-size: 15px; font-weight: 700; color: #FFB81C;
    text-decoration: underline; text-underline-offset: 3px;
  }
  .cover-stamp { margin-top: 6px; font-size: 11px; color: #888; }
  .cover-dots {
    position: absolute; right: 0.85in; bottom: 0.95in;
    display: grid; grid-template-columns: repeat(4, 8px); gap: 7px;
  }
  .cover-dots span { width: 8px; height: 8px; border-radius: 50%; background: #003087; }
  .cover-corner {
    position: absolute; right: 0; bottom: 0; width: 1.55in; height: 0.95in;
    background:
      linear-gradient(135deg, transparent 42%, #003087 42%, #003087 52%, transparent 52%),
      linear-gradient(135deg, transparent 54%, #FFB81C 54%, #FFB81C 64%, transparent 64%),
      linear-gradient(135deg, transparent 66%, #003087 66%, #003087 78%, transparent 78%);
  }

  .exec-page { padding: 0; }
  .fold-wrap { position: relative; height: 4.15in; overflow: hidden; background: #1a1a2e; }
  .fold-img { width: 100%; height: 100%; object-fit: cover; object-position: top center; display: block; }
  .fold-placeholder {
    width: 100%; height: 100%; display: flex; flex-direction: column;
    background: linear-gradient(160deg, #0b1f4d 0%, #003087 55%, #1a4a9e 100%);
    color: #fff;
  }
  .fold-placeholder-chrome {
    display: flex; align-items: center; gap: 6px; padding: 10px 14px;
    background: rgba(0,0,0,.25); font-size: 11px; color: #cbd5e1;
  }
  .fold-placeholder-chrome .dot {
    width: 8px; height: 8px; border-radius: 50%; background: #94a3b8;
  }
  .fold-url { margin-left: 10px; opacity: .9; }
  .fold-placeholder-inner {
    flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; padding: 0.4in;
  }
  .fold-placeholder-title { font-size: 22px; font-weight: 800; margin-bottom: 10px; }
  .fold-placeholder-hint { font-size: 12px; opacity: .8; max-width: 4.5in; line-height: 1.5; }
  .num-box {
    width: 0.7in; height: 0.7in; background: #FFB81C; color: #fff;
    font-size: 30px; font-weight: 800; display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .exec-body { padding: 0.32in 0.7in 0.55in; position: relative; }
  .exec-num { position: absolute; top: -0.34in; left: 0.55in; z-index: 2; }
  .exec-title {
    font-size: 25px; font-weight: 800; color: #003087; margin: 0.18in 0 0.06in 0.95in;
  }
  .exec-title.cont { margin-left: 0; }
  .cont-label { font-size: 14px; font-weight: 600; color: #64748b; text-transform: none; letter-spacing: 0; }
  .exec-rule {
    width: 0.55in; height: 4px; background: #FFB81C; margin: 0 0 0.18in 0.95in;
  }
  .content-page .exec-rule { margin-left: 0; }
  .exec-sub { font-size: 13px; font-weight: 700; color: #222; margin: 0.14in 0 0.06in; }
  .exec-sub.dashed { color: #1e293b; }
  .body { font-size: 12px; line-height: 1.6; color: #444; margin-bottom: 0.06in; }
  .page-footer {
    position: absolute; left: 0.75in; right: 0.75in; bottom: 0.28in;
    border-top: 1px solid #bbb; padding-top: 8px;
    font-size: 11px; color: #888; font-style: italic;
  }
  .footer-left { text-align: left; }
  .exec-page .page-footer { left: 0.7in; right: 0.7in; }

  .sec-head { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 0.22in; }
  .sec-title { font-size: 21px; font-weight: 800; color: #003087; letter-spacing: 0.5px; line-height: 1.2; }
  .sec-rule { width: 0.5in; height: 4px; background: #FFB81C; margin-top: 6px; }
  .subhead { font-size: 12.5px; font-weight: 700; color: #333; margin: 0.16in 0 0.08in; }
  .bullets { margin: 0.04in 0 0.1in 0.15in; padding-left: 0.2in; }
  .bullets.single { margin-bottom: 0.04in; }
  .bullets li { font-size: 12px; line-height: 1.5; color: #444; margin-bottom: 4px; }
  .value { font-size: 12px; line-height: 1.55; color: #333; margin-top: 0.18in; }
  .value strong { color: #003087; }

  .conclusion-page { display: flex; flex-direction: column; height: 11in; }
  .concl-main {
    flex: 1; background: #003087; color: #fff; padding: 0.65in 0.8in 0.45in;
    position: relative; overflow: hidden;
  }
  .concl-head { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 0.12in; }
  .concl-title { font-size: 28px; font-weight: 800; color: #fff; }
  .concl-rule { width: 0.55in; height: 4px; background: #FFB81C; margin: 8px 0 0.2in 0.84in; }
  .concl-body {
    font-size: 13px; line-height: 1.7; color: #f0f4fa; max-width: 6.4in;
    max-height: 4.8in; overflow: hidden;
  }
  .concl-logo-wrap { margin-top: 0.55in; display: flex; justify-content: center; }
  .concl-logo-card {
    background: #fff; padding: 12px 26px; border-radius: 4px;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .agency-logo { max-height: 48px; max-width: 220px; object-fit: contain; }
  .concl-footer {
    background: #e8e8e8; height: 1.85in; padding: 0.35in 0.6in 0.25in;
    display: flex; justify-content: space-around; align-items: flex-start; flex-shrink: 0;
  }
  .contact-col { text-align: center; width: 2.2in; }
  .contact-stem {
    width: 2px; height: 22px; background: #003087; margin: -0.35in auto 8px;
  }
  .contact-icon {
    width: 36px; height: 36px; border-radius: 50%; background: #FFB81C;
    display: inline-flex; align-items: center; justify-content: center;
    margin-bottom: 8px;
  }
  .contact-label { font-size: 13px; font-weight: 800; color: #003087; margin-bottom: 4px; }
  .contact-val { font-size: 11.5px; color: #003087; font-style: italic; text-decoration: underline; word-break: break-all; }
  .contact-val.addr { text-decoration: none; }
</style>
</head>
<body>

<section class="page cover">
  <div class="cover-gold-top"></div>
  <div class="cover-sidebar"></div>
  <div class="cover-gold-bot"></div>
  <div class="brand-row">${localWavesWordmark()}</div>
  <div class="cover-month">${esc(monthYear)}</div>
  <div class="cover-title">SEO &amp; PERFORMANCE<br/>REPORT</div>
  <p class="cover-summary">${esc(content.coverSummary)}</p>
  <div class="prep-band">
    <div class="prep-labels">
      <strong>Prepared For:</strong>
      <div class="val">${esc(clientName)}</div>
      <strong>Prepared By:</strong>
      <div class="val">${esc(content.preparedBy)}</div>
    </div>
    ${logoImg}
  </div>
  ${displayUrl ? `<div class="cover-url">${esc(displayUrl)}</div>` : ''}
  <div class="cover-stamp">Report Prepared: ${esc(monthYear)}</div>
  <div class="cover-dots">${Array.from({ length: 12 }).map(() => '<span></span>').join('')}</div>
  <div class="cover-corner"></div>
</section>

<section class="page exec-page">
  <div class="fold-wrap">${foldBlock}</div>
  <div class="exec-body">
    <div class="exec-num"><div class="num-box">01</div></div>
    <h2 class="exec-title">Executive Summary</h2>
    <div class="exec-rule"></div>
    ${execFirstHtml}
    ${pageFooter(footerLabel)}
  </div>
</section>

${execContHtml}

${sectionPagesHtml(content.sections, footerLabel)}

<section class="page conclusion-page">
  <div class="concl-main">
    <div class="concl-head">
      <div class="num-box">${pad2((content.sections?.length || 0) + 2)}</div>
      <div>
        <div class="concl-title">Conclusion</div>
      </div>
    </div>
    <div class="concl-rule"></div>
    <p class="concl-body">${esc(content.conclusion)}</p>
    <div class="concl-logo-wrap">
      <div class="concl-logo-card">${agencyLogo}</div>
    </div>
  </div>
  <div class="concl-footer">
    <div class="contact-col">
      <div class="contact-stem"></div>
      <div class="contact-icon">${iconEmail()}</div>
      <div class="contact-label">Email</div>
      <div class="contact-val">${esc(agencyEmail || '—')}</div>
    </div>
    <div class="contact-col">
      <div class="contact-stem"></div>
      <div class="contact-icon">${iconPhone()}</div>
      <div class="contact-label">Phone</div>
      <div class="contact-val">${esc(agencyPhone || '—')}</div>
    </div>
    <div class="contact-col">
      <div class="contact-stem"></div>
      <div class="contact-icon">${iconPin()}</div>
      <div class="contact-label">Address</div>
      <div class="contact-val addr">${esc(agencyAddress || '—')}</div>
    </div>
  </div>
</section>

</body>
</html>`;
}

export { normalizeAiContent, esc };
