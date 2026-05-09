/**
 * q1-tasks.cjs
 * Q1-pattern SEO task template for May 2026.
 * Used by: Keyway Broaching / Broaching Technologies, Great Lakes Power Vac.
 *
 * 72 parent tasks. Pages 1-10 and Pages 11-20 share the same goals and
 * steps — a helper `pageBatch(range)` expands one definition set into
 * both batches to keep the file compact.
 */

// ─── Per-page shared task bodies (reused for Pages 1-10 & 11-20) ─────────────
const PAGE_TASKS = [
  // Keyword Research (3)
  {
    suffix: 'Search intent analysis',
    taskType: 'keyword-research', priority: 'HIGH',
    section: 'Keyword Research', assigneeKey: 'mudassar',
    goal: 'Match content with user intent. Improve rankings and engagement. Increase conversions.',
    description: 'Analyze what users want when searching for your target keywords and align content accordingly.',
    steps: [
      'Identify target keywords for each page',
      'Classify intent (informational, navigational, transactional, commercial)',
      'Study top-ranking SERP content per keyword',
      'Adjust pages to match the dominant intent',
    ],
  },
  {
    suffix: 'Keyword research',
    taskType: 'keyword-research', priority: 'HIGH',
    section: 'Keyword Research', assigneeKey: 'mudassar',
    goal: 'Identify the right keywords driving qualified traffic and conversions.',
    description: 'Build a prioritized keyword list per page using volume, difficulty, intent, and business value.',
    steps: [
      'Seed list from business services and existing rankings',
      'Expand via Ahrefs/Semrush + Search Console',
      'Filter by volume, KD and intent alignment',
      'Assign primary + secondary keywords per page',
    ],
  },
  {
    suffix: 'Primary & secondary keyword mapping',
    taskType: 'keyword-research', priority: 'MEDIUM',
    section: 'Keyword Research', assigneeKey: 'mudassar',
    goal: 'Avoid cannibalization and ensure each page has a clear keyword focus.',
    description: 'Assign one primary keyword per page with supporting secondary keywords, documented in a mapping sheet.',
    steps: [
      'Create/update the keyword-to-page mapping sheet',
      'Assign one primary KW per page',
      'Assign 3-5 supporting secondaries',
      'Flag and resolve any cannibalization',
    ],
  },

  // Keyword Integration (2)
  {
    suffix: 'Meta tags title & description optimization',
    taskType: 'on-page-seo', priority: 'HIGH',
    section: 'Keyword Integration', assigneeKey: 'bisma',
    goal: 'Improve CTR and relevance signals on priority pages.',
    description: 'Rewrite titles and meta descriptions with the primary keyword, value prop, and CTA within limits.',
    steps: [
      'Audit current title + meta length and KW usage',
      'Rewrite each title (≤60 chars) and meta (≤155 chars)',
      'Include primary KW near the start of the title',
      'Deploy and monitor CTR movement in GSC',
    ],
  },
  {
    suffix: 'Header tags H1-H6 optimization',
    taskType: 'on-page-seo', priority: 'MEDIUM',
    section: 'Keyword Integration', assigneeKey: 'bisma',
    goal: 'Improve content structure, scannability, and semantic signals.',
    description: 'Ensure a single H1, logical H2/H3 hierarchy, and keyword-relevant subheadings.',
    steps: [
      'Audit heading outline per page',
      'Enforce single H1 with primary KW',
      'Rewrite H2/H3s with secondary KWs and user questions',
      'Validate hierarchy with a heading outline tool',
    ],
  },

  // Content Audit (4)
  {
    suffix: 'Existing content quality check',
    taskType: 'content-audit', priority: 'MEDIUM',
    section: 'Content Audit', assigneeKey: 'bisma',
    goal: 'Identify weak, thin, or outdated sections that hurt rankings.',
    description: 'Score each page on depth, clarity, freshness, originality, and intent match.',
    steps: [
      'Rubric-score each page (depth, freshness, intent)',
      'Flag thin/outdated sections',
      'Define rewrite vs refresh vs keep',
      'Queue actions with owners',
    ],
  },
  {
    suffix: 'Content gap analysis',
    taskType: 'content-audit', priority: 'MEDIUM',
    section: 'Content Audit', assigneeKey: 'bisma',
    goal: 'Find topics/angles competitors cover that we do not.',
    description: 'Compare our page coverage vs top competitors and list missing sections/questions.',
    steps: [
      'Pull top-3 competitor outlines per target page',
      'Diff headings and PAA coverage',
      'Record missing topics per page',
      'Feed gaps into the update plan',
    ],
  },
  {
    suffix: 'Content update & expansion',
    taskType: 'content-writing', priority: 'MEDIUM',
    section: 'Content Audit', assigneeKey: 'bisma',
    goal: 'Close identified gaps and lift rankings + time-on-page.',
    description: 'Update and expand pages to match intent, fill gaps, and refresh dated examples.',
    steps: [
      'Rewrite weak sections with gap-filler content',
      'Refresh facts, examples, and year references',
      'Add FAQs and supporting visuals',
      'Re-submit URLs in GSC',
    ],
  },
  {
    suffix: 'Duplicate content fixes',
    taskType: 'content-audit', priority: 'MEDIUM',
    section: 'Content Audit', assigneeKey: 'bisma',
    goal: 'Prevent dilution from duplicate or near-duplicate content.',
    description: 'Identify internal duplicates/boilerplate and consolidate, rewrite, or canonicalize as appropriate.',
    steps: [
      'Run Siteliner/Screaming Frog for duplicate detection',
      'Classify duplicates (boilerplate, near-dup, exact-dup)',
      'Rewrite or canonicalize',
      'Verify via re-crawl',
    ],
  },

  // UI/UX (5)
  {
    suffix: 'Mobile responsiveness check',
    taskType: 'technical-seo', priority: 'HIGH',
    section: 'UI/UX', assigneeKey: 'awais',
    goal: 'Ensure a smooth mobile experience for the mobile-first index.',
    description: 'Audit each page on mobile and fix layout, tap, viewport, and CLS issues.',
    steps: [
      'Run Lighthouse mobile on each page',
      'Fix tap targets, font sizes, viewport issues',
      'Resolve horizontal scroll and CLS',
      'Re-test and document fixes',
    ],
  },
  {
    suffix: 'Page layout & design improvements',
    taskType: 'ux-audit', priority: 'MEDIUM',
    section: 'UI/UX', assigneeKey: 'awais',
    goal: 'Improve clarity, scannability, and conversions.',
    description: 'Tune layout and visual hierarchy of priority pages.',
    steps: [
      'Audit above-the-fold clarity and CTA visibility',
      'Improve spacing, typography, and visual hierarchy',
      'Add supporting visuals where helpful',
      'Test with heatmaps/session recordings',
    ],
  },
  {
    suffix: 'User journey analysis',
    taskType: 'ux-audit', priority: 'MEDIUM',
    section: 'UI/UX', assigneeKey: 'awais',
    goal: 'Understand where users drop off and why.',
    description: 'Map the user journey per page and identify friction points.',
    steps: [
      'Map journeys from entry to conversion',
      'Identify drop-off steps via GA funnels',
      'Correlate with heatmaps/session recordings',
      'Propose targeted UX fixes',
    ],
  },
  {
    suffix: 'Navigation optimization',
    taskType: 'ux-audit', priority: 'MEDIUM',
    section: 'UI/UX', assigneeKey: 'awais',
    goal: 'Make primary paths obvious from any page.',
    description: 'Optimize menus, breadcrumbs, and internal links for usability and SEO.',
    steps: [
      'Audit main nav, footer, and contextual links',
      'Simplify nav labels (intent-led)',
      'Add breadcrumbs where missing',
      'Validate crawl paths post-change',
    ],
  },
  {
    suffix: 'Bounce rate improvement areas',
    taskType: 'ux-audit', priority: 'LOW',
    section: 'UI/UX', assigneeKey: 'awais',
    goal: 'Reduce bounce on high-traffic / high-bounce pages.',
    description: 'Identify and address the main reasons users leave quickly.',
    steps: [
      'List top-10 high-bounce pages',
      'Diagnose (speed, intent mismatch, layout)',
      'Apply targeted fixes',
      'Re-measure bounce after changes',
    ],
  },

  // URL Structure (4)
  {
    suffix: 'SEO-friendly URL creation',
    taskType: 'on-page-seo', priority: 'MEDIUM',
    section: 'URL Structure', assigneeKey: 'bisma',
    goal: 'Clean, keyword-rich, stable URLs.',
    description: 'Review URL slugs and plan any changes with 301s.',
    steps: [
      'Audit current slugs',
      'Propose clean, short, KW-bearing slugs',
      'Plan 301 redirects for any changes',
      'Deploy and verify',
    ],
  },
  {
    suffix: 'Readability optimization',
    taskType: 'on-page-seo', priority: 'LOW',
    section: 'URL Structure', assigneeKey: 'bisma',
    goal: 'Improve readability score and user comprehension.',
    description: 'Tighten sentences, simplify wording, and improve formatting.',
    steps: [
      'Check readability (Hemingway / Flesch)',
      'Shorten sentences and paragraphs',
      'Break walls of text with headings/lists',
      'Re-measure readability score',
    ],
  },
  {
    suffix: 'Keyword inclusion in URLs',
    taskType: 'on-page-seo', priority: 'LOW',
    section: 'URL Structure', assigneeKey: 'bisma',
    goal: 'Keep URL signals aligned with target keywords.',
    description: 'Ensure primary keyword is present in the URL slug where safe to change.',
    steps: [
      'Verify slug contains the primary KW',
      'Plan safe rewrites (with redirects)',
      'Deploy and monitor indexation',
      'Document changes',
    ],
  },
  {
    suffix: 'Canonicalization handling',
    taskType: 'technical-seo', priority: 'MEDIUM',
    section: 'URL Structure', assigneeKey: 'hamza',
    goal: 'Prevent duplicate indexing and ranking dilution.',
    description: 'Audit and fix canonical tag coverage across priority pages.',
    steps: [
      'Crawl to identify missing / conflicting canonicals',
      'Set self-canonicals where appropriate',
      'Resolve parameter / pagination canonicals',
      'Verify in GSC Coverage',
    ],
  },

  // CTA / CRO (2)
  {
    suffix: 'CTA placement analysis',
    taskType: 'cro', priority: 'MEDIUM',
    section: 'CTA / CRO', assigneeKey: 'bisma',
    goal: 'Lift conversion rate via better CTA positioning.',
    description: 'Analyse current CTA placement and visibility versus user attention paths.',
    steps: [
      'Map current CTA positions per page',
      'Cross-reference with heatmaps',
      'Define new placement hypotheses',
      'Prioritize A/B tests',
    ],
  },
  {
    suffix: 'CTA design & visibility improvement',
    taskType: 'cro', priority: 'MEDIUM',
    section: 'CTA / CRO', assigneeKey: 'bisma',
    goal: 'Make primary CTAs unmissable and compelling.',
    description: 'Improve CTA copy, contrast, size and supporting microcopy.',
    steps: [
      'Rewrite CTA copy (value-led)',
      'Strengthen contrast and size',
      'Add trust microcopy near CTAs',
      'Ship and monitor conversion lift',
    ],
  },
];

function pageBatch(range) {
  return PAGE_TASKS.map((t) => ({
    title: `${t.suffix} (Pages ${range})`,
    taskType: t.taskType,
    priority: t.priority,
    milestone: `A. Page-Level ${range} — ${t.section}`,
    assigneeKey: t.assigneeKey,
    goal: t.goal,
    description: t.description,
    steps: t.steps,
  }));
}

// ─── Non-page-level tasks (Competitive, Backlink Opp, AEO/GEO, GSC, B, C) ────
const OTHER_TASKS = [
  // Competitive Analysis (4)
  {
    title: 'Competitor keyword analysis',
    taskType: 'keyword-research', priority: 'MEDIUM',
    milestone: 'A. Competitive Analysis', assigneeKey: 'mudassar',
    goal: 'Find keywords competitors rank for that we should target.',
    description: 'Export competitor keyword sets and score for priority.',
    steps: [
      'Pull keyword sets for top-3 competitors',
      'Filter by relevance and winnable difficulty',
      'Map winners to our page plan',
      'Share prioritized list with content team',
    ],
  },
  {
    title: 'Competitor content review',
    taskType: 'content-audit', priority: 'MEDIUM',
    milestone: 'A. Competitive Analysis', assigneeKey: 'bisma',
    goal: 'Understand what competitor content does better than ours.',
    description: 'Deconstruct competitor top pages to extract winning patterns.',
    steps: [
      'Pick competitor top-5 pages per topic',
      'Break down outline, depth, media, schema',
      'List patterns we should adopt',
      'Apply insights to our briefs',
    ],
  },
  {
    title: 'Competitor backlink analysis',
    taskType: 'link-building', priority: 'MEDIUM',
    milestone: 'A. Competitive Analysis', assigneeKey: 'mudassar',
    goal: 'Find backlink sources we can replicate.',
    description: 'Review competitor referring domains and tag replication opportunities.',
    steps: [
      'Export referring domains per competitor',
      'Filter for quality and relevance',
      'Tag replicable vs PR-only',
      'Add replicable sources to outreach pipeline',
    ],
  },
  {
    title: 'Competitor gap coverage plan',
    taskType: 'content-audit', priority: 'MEDIUM',
    milestone: 'A. Competitive Analysis', assigneeKey: 'mudassar',
    goal: 'Turn competitive findings into an action plan.',
    description: 'Synthesize competitor gaps into a concrete plan with owners and deadlines.',
    steps: [
      'Consolidate KW + content + link gaps',
      'Prioritize by impact/effort',
      'Assign owners and due dates',
      'Track monthly progress',
    ],
  },

  // Backlink Opportunity (3)
  {
    title: 'Identify low-hanging backlink opportunities',
    taskType: 'link-building', priority: 'MEDIUM',
    milestone: 'A. Backlink Opportunity', assigneeKey: 'mudassar',
    goal: 'Start with the easiest placement wins.',
    description: 'Compile a list of fast-win backlink opportunities.',
    steps: [
      'Mine unlinked brand mentions',
      'Identify resource pages accepting links',
      'Find broken-link replacement opportunities',
      'Prioritize and hand off to outreach',
    ],
  },
  {
    title: 'Build free / generic backlinks (directories, citations)',
    taskType: 'link-building', priority: 'MEDIUM',
    milestone: 'A. Backlink Opportunity', assigneeKey: 'hamza',
    goal: 'Establish baseline citation and directory presence.',
    description: 'Claim free directory and citation listings with consistent NAP.',
    steps: [
      'Build directory target list',
      'Submit with consistent NAP',
      'Verify and track live URLs',
      'Monitor for duplicates/errors',
    ],
  },
  {
    title: 'Outreach to paid backlink prospects',
    taskType: 'link-building', priority: 'MEDIUM',
    milestone: 'A. Backlink Opportunity', assigneeKey: 'hamza',
    goal: 'Secure paid placements on vetted domains.',
    description: 'Pitch vendors, approve drafts, and close placements.',
    steps: [
      'Contact vendors with brief + target URL',
      'Approve drafts and anchor text',
      'Confirm publication and live URL',
      'Log placements and anchors',
    ],
  },

  // AEO / GEO (5)
  {
    title: 'FAQ section expansion for AEO',
    taskType: 'aeo-geo', priority: 'MEDIUM',
    milestone: 'A. AEO / GEO', assigneeKey: 'bisma',
    goal: 'Capture AEO / PAA visibility.',
    description: 'Expand FAQ coverage on priority pages with high-value user questions.',
    steps: [
      'Mine PAA and AI assistant questions',
      'Draft concise 40-60 word answers',
      'Deploy with FAQ schema',
      'Monitor rich result pickup',
    ],
  },
  {
    title: 'Structured content formatting for answer engines',
    taskType: 'aeo-geo', priority: 'MEDIUM',
    milestone: 'A. AEO / GEO', assigneeKey: 'bisma',
    goal: 'Increase snippet and AEO extraction rates.',
    description: 'Reformat priority pages with clear structures (lists, tables, headings).',
    steps: [
      'Identify pages with wall-of-text content',
      'Reformat into lists, tables, short paragraphs',
      'Add clear H2/H3 question-form headings',
      'Track featured snippet wins',
    ],
  },
  {
    title: 'Voice search query coverage',
    taskType: 'aeo-geo', priority: 'MEDIUM',
    milestone: 'A. AEO / GEO', assigneeKey: 'bisma',
    goal: 'Capture conversational queries.',
    description: 'Target natural-language question queries on key pages.',
    steps: [
      'Identify natural-language target queries',
      'Add question-form headings',
      'Provide concise, direct answers first',
      'Improve mobile UX/speed',
    ],
  },
  {
    title: 'Entity-based SEO — first pass',
    taskType: 'aeo-geo', priority: 'MEDIUM',
    milestone: 'A. AEO / GEO', assigneeKey: 'bisma',
    goal: 'Strengthen entity relationships across core pages.',
    description: 'Reinforce entity mentions, metadata, and structured data on core pages.',
    steps: [
      'Identify primary entities per page',
      'Align naming and metadata',
      'Add structured data (sameAs, about)',
      'Interlink related entities',
    ],
  },
  {
    title: 'Schema implementation for priority pages',
    taskType: 'schema-deployment', priority: 'HIGH',
    milestone: 'A. AEO / GEO', assigneeKey: 'bisma',
    goal: 'Boost rich result eligibility on priority pages.',
    description: 'Deploy the right schema types per page.',
    steps: [
      'Pick schema types per page (FAQ/HowTo/Article/Product)',
      'Write and deploy JSON-LD',
      'Validate with Rich Results Test',
      'Monitor Enhancements in GSC',
    ],
  },

  // GSC Monitoring (4)
  {
    title: 'Coverage report & indexing monitoring',
    taskType: 'reporting', priority: 'HIGH',
    milestone: 'A. GSC Monitoring', assigneeKey: 'sami',
    goal: 'Keep priority pages indexed and healthy.',
    description: 'Monitor Coverage/Indexing reports weekly and fix root causes.',
    steps: [
      'Check Coverage weekly',
      'Triage excluded/errored URLs',
      'Fix robots/canonical/duplicate issues',
      'Request re-indexing',
    ],
  },
  {
    title: 'Crawl error fixes from GSC',
    taskType: 'crawl-fix', priority: 'HIGH',
    milestone: 'A. GSC Monitoring', assigneeKey: 'sami',
    goal: 'Reduce crawl waste and broken paths.',
    description: 'Close out crawl errors reported in GSC.',
    steps: [
      'Export GSC crawl errors',
      'Classify by error type',
      'Deploy fixes (redirects, status codes)',
      'Verify resolution in GSC',
    ],
  },
  {
    title: 'Sitemap submission monitoring',
    taskType: 'reporting', priority: 'MEDIUM',
    milestone: 'A. GSC Monitoring', assigneeKey: 'sami',
    goal: 'Keep sitemaps accurate and discoverable.',
    description: 'Verify sitemap health and discovery in GSC.',
    steps: [
      'Check sitemap status in GSC',
      'Remove invalid/noindex URLs',
      'Add new pages promptly',
      'Track indexed counts',
    ],
  },
  {
    title: 'Content insights & performance analysis',
    taskType: 'reporting', priority: 'MEDIUM',
    milestone: 'A. GSC Monitoring', assigneeKey: 'sami',
    goal: 'Turn GSC data into editorial decisions.',
    description: 'Analyse queries, pages, and CTR to guide content priorities.',
    steps: [
      'Pull GSC performance data',
      'Identify rising / falling queries and pages',
      'Flag candidates for optimization',
      'Share insights with content team',
    ],
  },

  // B. Content Expansion (4)
  {
    title: 'Blog topic research for expansion',
    taskType: 'content-writing', priority: 'MEDIUM',
    milestone: 'B. Content Expansion', assigneeKey: 'bisma',
    goal: 'Fuel content pipeline with relevant, rankable topics.',
    description: 'Research and shortlist high-intent blog topics for the quarter.',
    steps: [
      'Seed topics from KW research and PAA',
      'Score by volume, difficulty, value',
      'Validate against intent and SERPs',
      'Publish approved topic list',
    ],
  },
  {
    title: 'Keyword-based blog content creation',
    taskType: 'content-writing', priority: 'MEDIUM',
    milestone: 'B. Content Expansion', assigneeKey: 'bisma',
    goal: 'Write content that targets real search demand.',
    description: 'Brief and write blog posts anchored to primary + secondary keywords.',
    steps: [
      'Create SEO briefs per topic',
      'Write with KW placement + depth',
      'Add images, schema, internal links',
      'Peer-review before publish',
    ],
  },
  {
    title: 'Blog writing & optimization',
    taskType: 'content-writing', priority: 'MEDIUM',
    milestone: 'B. Content Expansion', assigneeKey: 'bisma',
    goal: 'Produce on-brand, optimized blog posts.',
    description: 'Finalize drafts with on-page SEO checks.',
    steps: [
      'Optimize titles, meta, H1s',
      'Add alt text and internal links',
      'Check readability and flow',
      'Final QA and publish',
    ],
  },
  {
    title: 'Blog publishing & indexing',
    taskType: 'content-writing', priority: 'MEDIUM',
    milestone: 'B. Content Expansion', assigneeKey: 'bisma',
    goal: 'Get new content indexed quickly.',
    description: 'Publish, submit, and verify indexing for new posts.',
    steps: [
      'Publish to CMS with correct metadata',
      'Submit URL in GSC',
      'Verify indexation',
      'Share internally for promotion',
    ],
  },

  // B. Content Cluster (3)
  {
    title: 'Pillar page audit & plan',
    taskType: 'content-audit', priority: 'MEDIUM',
    milestone: 'B. Content Cluster', assigneeKey: 'bisma',
    goal: 'Ensure pillars are strong hubs for each core topic.',
    description: 'Audit existing pillars and plan improvements.',
    steps: [
      'Score each pillar on depth/links/freshness',
      'Identify weak pillars',
      'Plan cluster expansion per pillar',
      'Set success metrics',
    ],
  },
  {
    title: 'Cluster page creation',
    taskType: 'content-writing', priority: 'MEDIUM',
    milestone: 'B. Content Cluster', assigneeKey: 'bisma',
    goal: 'Expand topical authority around pillars.',
    description: 'Write supporting cluster pages for priority pillars.',
    steps: [
      'Pick pillars to expand',
      'Brief cluster topics',
      'Write and interlink to pillar',
      'Track ranking impact',
    ],
  },
  {
    title: 'Interlinking pillar and cluster pages',
    taskType: 'link-building', priority: 'MEDIUM',
    milestone: 'B. Content Cluster', assigneeKey: 'bisma',
    goal: 'Route authority inside each cluster correctly.',
    description: 'Strengthen internal links between pillars and clusters.',
    steps: [
      'Map current internal links per cluster',
      'Add cluster→pillar links',
      'Add cross-cluster contextual links',
      'Re-crawl and verify',
    ],
  },

  // B. Local SEO & PR (3)
  {
    title: 'GBP optimization & posts',
    taskType: 'local-seo', priority: 'HIGH',
    milestone: 'B. Local SEO & PR', assigneeKey: 'hamza',
    goal: 'Grow local visibility, calls, and direction requests.',
    description: 'Optimize GBP and publish consistent posts.',
    steps: [
      'Complete all GBP fields',
      'Add services, products, attributes',
      'Publish weekly posts',
      'Monitor insights',
    ],
  },
  {
    title: 'Local citations & directories',
    taskType: 'local-seo', priority: 'MEDIUM',
    milestone: 'B. Local SEO & PR', assigneeKey: 'hamza',
    goal: 'Reinforce NAP across the local web.',
    description: 'Claim and correct citations on major local directories.',
    steps: [
      'Audit existing citations',
      'Correct NAP inconsistencies',
      'Submit to priority directories',
      'Track live listings',
    ],
  },
  {
    title: 'Digital PR for brand mentions',
    taskType: 'link-building', priority: 'MEDIUM',
    milestone: 'B. Local SEO & PR', assigneeKey: 'hamza',
    goal: 'Earn brand mentions and authority links.',
    description: 'Pitch press-ready angles to relevant publications.',
    steps: [
      'Develop pitch-ready angles',
      'Build media list',
      'Pitch and follow up',
      'Track mentions and links',
    ],
  },

  // B. Authority Link (3)
  {
    title: 'High-DR outreach campaign',
    taskType: 'link-building', priority: 'HIGH',
    milestone: 'B. Authority Link Building', assigneeKey: 'mudassar',
    goal: 'Earn high-DR referring domains.',
    description: 'Run outreach campaigns to authoritative niche sites.',
    steps: [
      'Build prospect list (DR, relevance)',
      'Prepare pitch templates',
      'Execute outreach + follow-up',
      'Secure placements',
    ],
  },
  {
    title: 'Paid backlinks placement',
    taskType: 'link-building', priority: 'HIGH',
    milestone: 'B. Authority Link Building', assigneeKey: 'mudassar',
    goal: 'Accelerate authority via vetted paid placements.',
    description: 'Execute paid backlink placements on approved vendors.',
    steps: [
      'Brief vendors with target URL + anchor',
      'Approve drafts',
      'Confirm live placements',
      'Log and monitor impact',
    ],
  },
  {
    title: 'Disavow toxic backlinks',
    taskType: 'link-building', priority: 'HIGH',
    milestone: 'B. Authority Link Building', assigneeKey: 'hamza',
    goal: 'Protect site from harmful backlink signals.',
    description: 'Audit and disavow toxic backlinks.',
    steps: [
      'Pull full backlink profile',
      'Flag toxic/spammy domains',
      'Attempt removal where practical',
      'Submit disavow file',
    ],
  },

  // B. CRO (2)
  {
    title: 'CRO — conversion funnel audit',
    taskType: 'cro', priority: 'MEDIUM',
    milestone: 'B. CRO', assigneeKey: 'bisma',
    goal: 'Find the biggest leaks in the conversion funnel.',
    description: 'Audit funnel steps end-to-end and prioritize fixes.',
    steps: [
      'Map the full funnel',
      'Measure drop-offs per step',
      'Interview stakeholders / users',
      'Publish prioritized fix list',
    ],
  },
  {
    title: 'CRO — A/B test CTAs on top pages',
    taskType: 'cro', priority: 'MEDIUM',
    milestone: 'B. CRO', assigneeKey: 'bisma',
    goal: 'Lift conversion rate on top-traffic pages.',
    description: 'Run A/B tests on CTA copy, design, and placement.',
    steps: [
      'Pick top-5 pages by traffic/value',
      'Design A/B variants',
      'Run tests to significance',
      'Ship winners + document',
    ],
  },

  // C. Final Performance & KPI Report (2)
  {
    title: 'Compile final KPI report (traffic, rankings, conversions)',
    taskType: 'reporting', priority: 'HIGH',
    milestone: 'C. Final Performance & KPI Report', assigneeKey: 'sami',
    goal: 'Quantify quarter outcomes for client.',
    description: 'Pull and analyze traffic, rankings, and conversion data for the quarter.',
    steps: [
      'Pull GA/GSC data for quarter',
      'Compare vs prior quarter baseline',
      'Write insights + next-quarter recs',
      'Design report deck',
    ],
  },
  {
    title: 'Present end-of-quarter performance review',
    taskType: 'reporting', priority: 'HIGH',
    milestone: 'C. Final Performance & KPI Report', assigneeKey: 'sami',
    goal: 'Align client on results and next-quarter plan.',
    description: 'Host the quarter review call and capture next-step decisions.',
    steps: [
      'Schedule stakeholder review',
      'Present KPI report',
      'Capture decisions / priorities',
      'Publish meeting notes',
    ],
  },
];

module.exports = [
  ...pageBatch('1-10'),
  ...pageBatch('11-20'),
  ...OTHER_TASKS,
];
