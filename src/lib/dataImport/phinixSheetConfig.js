/**
 * Phinix Solutions Google Sheets → Agency OS import sources (June 2026).
 * Master index: https://docs.google.com/spreadsheets/d/1QKeal5ODU-6Wy4p0fbiZr_e6NoMAX_RtWzyK0hbpeck/
 */

export const PHINIX_MASTER_SPREADSHEET_ID = '1QKeal5ODU-6Wy4p0fbiZr_e6NoMAX_RtWzyK0hbpeck';

export const PHINIX_TEAM_ROSTER = {
  hamza: {
    email: 'hamza@thephinixsolutions.com',
    name: 'Hamza Ashraf',
    role: 'PM',
    required: true,
  },
  sami: {
    email: 'sami@thephinixsolutions.com',
    name: 'Sami Ullah',
    role: 'PM',
    required: true,
  },
  mudassar: {
    email: 'mudassar@thephinixsolutions.com',
    name: 'Mudassar Nazar',
    role: 'TEAM_MEMBER',
    required: true,
  },
  bisma: {
    email: 'bisma@thephinixsolutions.com',
    name: 'Bisma Syed',
    role: 'TEAM_MEMBER',
    required: true,
  },
  awais: {
    email: 'awais@thephinixsolutions.com',
    name: 'Awais Sadiq',
    role: 'TEAM_MEMBER',
    required: true,
  },
  haider: {
    email: 'haider@thephinixsolutions.com',
    name: 'Haider',
    role: 'TEAM_MEMBER',
    required: false,
  },
};

export const ASSIGNEE_TAB_NAMES = ['Hamza', 'Haider', 'Bisma', 'Mudassar', 'M Sami', 'Awais'];

/** Map sheet tab / cell assignee label → teamRoster key */
export function resolveAssigneeKey(raw = '') {
  const n = String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
  if (!n) return null;
  if (n.includes('hamza')) return 'hamza';
  if (n.includes('haider')) return 'haider';
  if (n.includes('bisma')) return 'bisma';
  if (n.includes('mudassar')) return 'mudassar';
  if (n.includes('m sami') || n === 'sami' || n.includes('sami')) return 'sami';
  if (n.includes('awais')) return 'awais';
  if (n.includes('ahmer')) return 'ahmer';
  if (n.includes('abdullah')) return null;
  return n.replace(/[^a-z]/g, '').slice(0, 20) || null;
}

/**
 * Per-client task plan spreadsheets (assignee tabs hold row-level tasks + status).
 */
export const PHINIX_PROJECTS = [
  {
    ref: 'proj-roman-electric',
    projectMatch: { projectNameContains: 'Roman Electric' },
    name: 'SEO - Roman Electric Co.',
    planLabel: 'Roman Electric Q2 — Jun 2026',
    spreadsheetId: '1N-RbkXB9rSXqYiGkaJc3p5ARwIzQkFmgwOdcVgmcLU0',
    masterTab: 'Roman Electric - Q2',
    leadPmKey: 'hamza',
    projectType: 'SEO_CAMPAIGN',
    wpUrl: 'https://www.romanelectric.com',
  },
  {
    ref: 'proj-milwaukee-signs',
    projectMatch: { projectNameContains: 'Milwaukee Signs' },
    name: 'SEO - Milwaukee Signs',
    planLabel: 'Milwaukee Signs Q2 — Jun 2026',
    spreadsheetId: '1rYzJpiYc7Miw9VuJ-PnSZ4dgZGrGfMyKJkVmpcG_igI',
    masterTab: 'Milwaukee Signs - Q2',
    leadPmKey: 'hamza',
    projectType: 'SEO_CAMPAIGN',
    wpUrl: 'https://www.signarama.com',
  },
  {
    ref: 'proj-p2ezpay',
    projectMatch: { projectNameContains: 'P2EzPay' },
    name: 'SEO - P2EzPay',
    planLabel: 'P2EzPay Q2 — Jun 2026',
    spreadsheetId: '1jnCPtFqC6CIBkWj-A6VA7ZdnWfrHjKfz96_5a3qnW-g',
    masterTab: 'P2EzPay - Q2',
    leadPmKey: 'hamza',
    projectType: 'SEO_CAMPAIGN',
    wpUrl: 'https://www.p2ezpay.com',
  },
  {
    ref: 'proj-great-lakes',
    projectMatch: { projectNameContains: 'Great Lakes Power Vac' },
    name: 'SEO - Great Lakes Power Vac',
    planLabel: 'Great Lakes Power Vac Q1 — Jun 2026',
    spreadsheetId: '1oztGtps4U7PejoEtTS8poz4haAbDRYNEgKffeY1xlY0',
    masterTab: 'Great Lakes Power Vac - Q1',
    leadPmKey: 'hamza',
    projectType: 'SEO_CAMPAIGN',
    wpUrl: 'https://www.greatlakespowervac.com',
  },
  {
    ref: 'proj-keyway-broaching',
    projectMatch: { projectNameContains: 'Broaching' },
    name: 'SEO - Keyway Broaching',
    planLabel: 'Keyway Broaching Q1 — Jun 2026',
    spreadsheetId: '1tpCB4K-1vOkV0HWGn_Mb74bm6jl7Z7KlrXsb0NUleH4',
    masterTab: 'Keyway Broaching - Q1',
    leadPmKey: 'hamza',
    projectType: 'SEO_CAMPAIGN',
    wpUrl: 'https://www.keyway-spline-broaching.com',
  },
  {
    ref: 'proj-wilhelmina',
    projectMatch: { projectNameContains: 'Wilhelmina' },
    name: 'SEO - Wilhelmina Balloon',
    planLabel: 'Wilhelmina Balloon Q1 — Jun 2026',
    spreadsheetId: '1MXgTYYt4IO_ORvPmD8d21cc3kXFOYO5LjV7zKbMiO-M',
    masterTab: 'Wilhelmina Balloon - Q1',
    leadPmKey: 'hamza',
    projectType: 'SEO_CAMPAIGN',
    wpUrl: 'https://www.wilhelminaballoons.com',
  },
  {
    ref: 'proj-southgate',
    projectMatch: { projectNameContains: 'SouthGate' },
    name: 'Local SEO - SouthGate Lease',
    planLabel: 'SouthGate Lease Local SEO — Jun 2026',
    spreadsheetId: '1o95Y5k-XyDuGr6bjnMRDm-z0uGva3ON_UpVAgU6W0z0',
    masterTab: 'SouthGate Lease - Local SEO Tasks',
    leadPmKey: 'hamza',
    projectType: 'SEO_CAMPAIGN',
    wpUrl: null,
    assigneeTabs: ['Hamza'],
  },
];

export function gvizCsvUrl(spreadsheetId, sheetName) {
  const enc = encodeURIComponent(sheetName);
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&sheet=${enc}`;
}

/** Public edit link (reviewers open spreadsheet; navigate to assignee tab by name). */
export function spreadsheetEditUrl(spreadsheetId) {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

export function masterPlanUrl() {
  return spreadsheetEditUrl(PHINIX_MASTER_SPREADSHEET_ID);
}

export const ENRICH_MARKER = '[phinix-sheet-enriched]';
