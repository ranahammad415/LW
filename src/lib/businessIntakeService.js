/**
 * Business intake orchestrator: turns a structured intake payload into the
 * client's OKF markdown files, then grades how complete the knowledge base is.
 */
import { prisma } from './prisma.js';
import {
  initializeClientDirs,
  writeOkfFile,
  listClientFiles,
  readOkfFile,
  slugify,
} from './knowledgeEngine.js';
import { logOkfAccess } from './okfAccessLog.js';

export const INTAKE_STATUSES = {
  NOT_STARTED: 'INTAKE_NOT_STARTED',
  IN_PROGRESS: 'INTAKE_IN_PROGRESS',
  REVIEW_REQUIRED: 'INTAKE_REVIEW_REQUIRED',
  APPROVED: 'INTAKE_APPROVED',
  INCOMPLETE_BLOCKS_GEO: 'INTAKE_INCOMPLETE_BLOCKS_GEO',
};

const REQUIRED_OKF_PATHS = [
  'company/profile.md',
  'voice/brand-voice.md',
  'company/approved-claims.md',
];

function hasOkfContent(clientId, folder, filename) {
  try {
    const doc = readOkfFile(clientId, folder, filename);
    return String(doc.body || '').trim().length > 20;
  } catch {
    return false;
  }
}

/**
 * Assess OKF completeness. GEO-heavy workflows need proof, brand voice and
 * approved claims on file before they can run safely.
 */
export function assessOkfIntakeCompleteness(clientId) {
  const profileComplete = hasOkfContent(clientId, 'company', 'profile');
  const voiceComplete = hasOkfContent(clientId, 'voice', 'brand-voice');
  const approvedClaimsComplete = hasOkfContent(clientId, 'company', 'approved-claims');
  const proofComplete = hasOkfContent(clientId, 'proof', 'testimonials')
    || hasOkfContent(clientId, 'proof', 'case-studies');

  const geoReady = profileComplete && voiceComplete && approvedClaimsComplete && proofComplete;

  const missing = [];
  if (!profileComplete) missing.push('company/profile.md');
  if (!voiceComplete) missing.push('voice/brand-voice.md');
  if (!approvedClaimsComplete) missing.push('company/approved-claims.md');
  if (!proofComplete) missing.push('proof/testimonials.md or proof/case-studies.md');

  return {
    profileComplete,
    voiceComplete,
    approvedClaimsComplete,
    proofComplete,
    geoReady,
    missing,
    blocksGeo: !geoReady,
  };
}

function resolveIntakeStatus(assessment) {
  if (assessment.geoReady) return INTAKE_STATUSES.APPROVED;
  if (assessment.profileComplete) return INTAKE_STATUSES.REVIEW_REQUIRED;
  return INTAKE_STATUSES.INCOMPLETE_BLOCKS_GEO;
}

/**
 * Run the intake orchestrator — writes OKF files from a structured payload.
 */
export async function runBusinessIntakeOrchestration(clientId, intakeData = {}, userId = null, projectId = null) {
  initializeClientDirs(clientId);

  const client = await prisma.clientAccount.findUnique({ where: { id: clientId } });
  if (!client) throw new Error(`Client ${clientId} not found`);

  if (!projectId) {
    const project = await prisma.project.findFirst({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
    projectId = project?.id || null;
  }

  const {
    businessName,
    website,
    industry,
    services = [],
    locations = [],
    serviceAreas = [],
    targetCustomers,
    competitors = [],
    usps = [],
    approvedClaims = [],
    restrictedClaims = [],
    faqs = [],
    testimonials = [],
    caseStudies = [],
    brandVoice,
    proofLinks = [],
    gbpDetails = null,
    gscConnected = false,
    ga4Connected = false,
    gbpConnected = false,
  } = intakeData;

  const name = businessName || client.agencyName;
  const competitorNames = competitors.map((c) => (typeof c === 'string' ? c : c.name || c.domain)).filter(Boolean);

  // ── company/profile.md ──
  const profileBody = [
    `# ${name}`,
    '',
    website ? `**Website:** ${website}` : '',
    industry ? `**Industry:** ${industry}` : '',
    serviceAreas.length ? `**Service areas:** ${serviceAreas.join(', ')}` : '',
    targetCustomers ? `**Target customers:** ${targetCustomers}` : '',
    usps.length ? `\n## Unique Selling Points\n${usps.map((u) => `- ${u}`).join('\n')}` : '',
    competitorNames.length ? `\n## Competitors\n${competitorNames.map((c) => `- ${c}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');

  writeOkfFile(clientId, 'company', 'profile', {
    type: 'company-profile',
    title: `${name} Company Profile`,
    agency_name: name,
    website_url: website || client.websiteUrl,
    industry: industry || client.industry,
    service_areas: serviceAreas,
    target_customers: targetCustomers,
    competitors: competitorNames,
    usps,
    gsc_connected: gscConnected,
    ga4_connected: ga4Connected,
    gbp_connected: gbpConnected,
  }, profileBody);

  if (approvedClaims.length) {
    writeOkfFile(clientId, 'company', 'approved-claims', {
      type: 'approved-claims',
      title: 'Approved Claims',
    }, approvedClaims.map((c) => `- ${c}`).join('\n'));
  }

  if (restrictedClaims.length) {
    writeOkfFile(clientId, 'company', 'restricted-claims', {
      type: 'restricted-claims',
      title: 'Restricted Claims',
    }, restrictedClaims.map((c) => `- ${c}`).join('\n'));
  }

  if (targetCustomers) {
    writeOkfFile(clientId, 'company', 'target-audience', {
      type: 'target-audience',
      title: 'Target Audience',
    }, `# Target Audience\n\n${targetCustomers}`);
  }

  for (const svc of services) {
    const svcName = typeof svc === 'string' ? svc : svc.name || 'service';
    const slug = slugify(svcName);
    if (!slug) continue;
    const body = typeof svc === 'string'
      ? `## ${svc}\n\nService offering for ${name}.`
      : (svc.description || `## ${svcName}`);
    writeOkfFile(clientId, 'services', slug, { type: 'service', title: svcName }, body);
  }

  for (const loc of locations) {
    const locName = typeof loc === 'string' ? loc : loc.name || 'location';
    const slug = slugify(locName);
    if (!slug) continue;
    writeOkfFile(clientId, 'locations', slug, { type: 'location', title: locName },
      `## ${locName}\n\nService location for ${name}.`);
  }

  for (let i = 0; i < faqs.length; i++) {
    const faq = faqs[i];
    const q = faq.question || faq.q || `FAQ ${i + 1}`;
    const a = faq.answer || faq.a || '';
    const slug = slugify(q.slice(0, 40)) || `faq-${i + 1}`;
    writeOkfFile(clientId, 'faq', slug, { type: 'faq', title: q, question: q }, `**${q}**\n\n${a}`);
  }

  if (testimonials.length) {
    writeOkfFile(clientId, 'proof', 'testimonials', { type: 'testimonials', title: 'Testimonials' },
      testimonials
        .map((t) => (typeof t === 'string' ? `- ${t}` : `> "${t.quote}" — ${t.author || 'Client'}`))
        .join('\n\n'));
  }

  if (caseStudies.length) {
    writeOkfFile(clientId, 'proof', 'case-studies', { type: 'case-studies', title: 'Case Studies' },
      caseStudies
        .map((c) => (typeof c === 'string' ? `## ${c}` : `## ${c.title}\n${c.summary || ''}`))
        .join('\n\n'));
  }

  if (brandVoice) {
    writeOkfFile(clientId, 'voice', 'brand-voice', { type: 'brand-voice', title: 'Brand Voice' },
      typeof brandVoice === 'string' ? brandVoice : JSON.stringify(brandVoice, null, 2));
  }

  for (const compName of competitorNames) {
    const slug = slugify(compName);
    if (!slug) continue;
    writeOkfFile(clientId, 'competitors', slug, { type: 'competitor', title: compName, name: compName },
      `## ${compName}\n\nCompetitor tracked for ${name}.`);
  }

  writeOkfFile(clientId, 'seo/strategy', 'project-strategy', {
    type: 'seo-strategy',
    title: 'Project SEO Strategy',
    project_id: projectId,
  }, [
    `# SEO Strategy — ${name}`,
    '',
    `Primary website: ${website || client.websiteUrl || 'TBD'}`,
    serviceAreas.length ? `Primary markets: ${serviceAreas.join(', ')}` : '',
    competitorNames.length ? `Key competitors: ${competitorNames.join(', ')}` : '',
  ].filter(Boolean).join('\n'));

  if (proofLinks.length) {
    writeOkfFile(clientId, 'knowledge-gaps', 'intake-proof-links', {
      type: 'knowledge-gap',
      title: 'Intake Proof Links',
    }, proofLinks.map((l) => `- ${l}`).join('\n'));
  }

  if (gbpDetails) {
    writeOkfFile(clientId, 'seo/local', 'gbp-details', { type: 'gbp-profile', title: 'GBP Details' },
      typeof gbpDetails === 'string' ? gbpDetails : JSON.stringify(gbpDetails, null, 2));
  }

  const assessment = assessOkfIntakeCompleteness(clientId);
  const intakeStatus = resolveIntakeStatus(assessment);
  const files = listClientFiles(clientId);

  await prisma.clientAccount.update({
    where: { id: clientId },
    data: {
      intakeStatus,
      intakeData,
      intakeCompletedAt: assessment.geoReady ? new Date() : null,
      websiteUrl: website || client.websiteUrl,
      industry: industry || client.industry,
    },
  });

  await logOkfAccess({
    clientId,
    userId,
    action: 'INTAKE_ORCHESTRATION',
    filePath: 'company/profile.md',
    folder: 'company',
    filename: 'profile.md',
    agentName: 'Business Intake Orchestrator',
    reason: `Intake orchestration for ${name} (${files.length} OKF files)`,
  });

  return {
    success: true,
    clientId,
    intakeStatus,
    assessment,
    okfFilesCreated: files.length,
    requiredPaths: REQUIRED_OKF_PATHS,
    geoBlocked: assessment.blocksGeo,
  };
}

/**
 * Intake completion status for the client dashboard card.
 */
export async function getIntakeStatus(clientId) {
  const client = await prisma.clientAccount.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      agencyName: true,
      intakeStatus: true,
      intakeData: true,
      intakeCompletedAt: true,
      websiteUrl: true,
    },
  });
  if (!client) throw new Error('Client not found');

  const assessment = assessOkfIntakeCompleteness(clientId);
  const files = listClientFiles(clientId);

  return {
    clientId,
    agencyName: client.agencyName,
    intakeStatus: client.intakeStatus || INTAKE_STATUSES.NOT_STARTED,
    intakeCompletedAt: client.intakeCompletedAt,
    assessment,
    okfFileCount: files.length,
    okfFiles: files.slice(0, 50).map((f) => f.rel_path),
  };
}

export { REQUIRED_OKF_PATHS };
