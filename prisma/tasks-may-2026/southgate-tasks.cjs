/**
 * southgate-tasks.cjs
 * SouthGate Lease: Local SEO only (GBP Foundation + Local Citation).
 * 7 parent tasks, all assigned to Hamza.
 */
module.exports = [
  // GBP Foundation (4)
  {
    title: 'Google Business Profile setup',
    taskType: 'local-seo', priority: 'HIGH',
    milestone: 'GBP Foundation', assigneeKey: 'hamza',
    goal: 'Establish a strong local presence on Google.',
    description: 'Create or claim and fully set up the GBP listing.',
    steps: [
      'Claim / create the GBP listing',
      'Verify ownership',
      'Complete all profile fields',
      'Publish first post',
    ],
  },
  {
    title: 'Business information optimization (NAP)',
    taskType: 'local-seo', priority: 'HIGH',
    milestone: 'GBP Foundation', assigneeKey: 'hamza',
    goal: 'Ensure consistent NAP across the web.',
    description: 'Align business Name, Address, Phone across site, GBP, and citations.',
    steps: [
      'Define the canonical NAP',
      'Update site footer / contact pages',
      'Update GBP to match',
      'Align across citations',
    ],
  },
  {
    title: 'GBP category & service setup',
    taskType: 'local-seo', priority: 'MEDIUM',
    milestone: 'GBP Foundation', assigneeKey: 'hamza',
    goal: 'Maximise GBP category and service coverage.',
    description: 'Pick the right primary + secondary categories and list all services.',
    steps: [
      'Research competitor categories',
      'Set primary + secondary categories',
      'Add full services list',
      'Add attributes and products',
    ],
  },
  {
    title: 'GBP initial posts & updates',
    taskType: 'local-seo', priority: 'MEDIUM',
    milestone: 'GBP Foundation', assigneeKey: 'hamza',
    goal: 'Signal active management to Google.',
    description: 'Publish a starter set of GBP posts, offers, and updates.',
    steps: [
      'Draft 4 opening posts',
      'Add offers / events if relevant',
      'Publish and schedule cadence',
      'Monitor insights',
    ],
  },

  // Local Citation / Directory Submission (3)
  {
    title: 'Business listing creation on directories',
    taskType: 'local-seo', priority: 'MEDIUM',
    milestone: 'Local Citation / Directory Submission', assigneeKey: 'hamza',
    goal: 'Expand discoverable citations.',
    description: 'Create listings on major local and niche directories.',
    steps: [
      'Build directory target list',
      'Submit with canonical NAP',
      'Verify and track live URLs',
      'Watch for duplicates',
    ],
  },
  {
    title: 'NAP consistency check across citations',
    taskType: 'local-seo', priority: 'MEDIUM',
    milestone: 'Local Citation / Directory Submission', assigneeKey: 'hamza',
    goal: 'Remove conflicting NAP signals.',
    description: 'Audit existing citations and fix NAP inconsistencies.',
    steps: [
      'Pull existing citations',
      'Identify inconsistencies',
      'Update or request corrections',
      'Re-verify',
    ],
  },
  {
    title: 'Directory submissions (local & niche)',
    taskType: 'local-seo', priority: 'MEDIUM',
    milestone: 'Local Citation / Directory Submission', assigneeKey: 'hamza',
    goal: 'Keep building citation depth.',
    description: 'Continue submitting to quality local and niche directories.',
    steps: [
      'Queue next-tier directories',
      'Submit with canonical NAP',
      'Track live listings',
      'Report citation growth',
    ],
  },
];
