/**
 * Owner admin connection / adapter health checks.
 * Never returns secrets — only status + messages.
 */

import { prisma } from '../prisma.js';
import { getDataForSeo } from '../dataforseo/client.js';
import { fetchGmbInfo } from '../omniSearch/businessDataProvider.js';
import {
  BUSINESS_DATA_PROVIDER,
  SERP_PROVIDER,
  KEYWORD_DATA_PROVIDER,
  BACKLINK_PROVIDER,
  hasRealBusinessDataProvider,
  hasRealSerpProvider,
  hasRealKeywordProvider,
  hasRealBacklinkProvider,
} from '../omniSearch/omniSearchConfig.js';
import { getAgencyConnectionStatus, isAgencyGoogleOAuthConfigured } from './googleAuth.js';
import { isOpenRouterConfigured } from '../openrouter/client.js';
import { isAiConfigured } from '../ai.js';
import { dfsKeywordForProject } from './gmbIdentifier.js';

function check(id, label, status, message, extra = {}) {
  return { id, label, status, message, ...extra };
}

async function timed(fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    return { ok: true, result, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: err, latencyMs: Date.now() - t0 };
  }
}

async function checkDataForSeoAuth() {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) {
    return check('dataforseo_auth', 'DataForSEO auth', 'fail', 'DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set');
  }
  const { ok, result, error, latencyMs } = await timed(() =>
    getDataForSeo('/v3/appendix/user_data')
  );
  if (!ok) {
    return check(
      'dataforseo_auth',
      'DataForSEO auth',
      'fail',
      error?.message || 'DataForSEO request failed',
      { latencyMs }
    );
  }
  const task = result?.tasks?.[0];
  const code = task?.status_code;
  if (code && code >= 40000) {
    return check(
      'dataforseo_auth',
      'DataForSEO auth',
      'fail',
      task.status_message || `DFS status ${code}`,
      { latencyMs }
    );
  }
  const money = task?.result?.[0]?.money;
  const balance =
    money?.balance != null
      ? `Balance ~${money.balance}`
      : task?.status_message || 'Authenticated';
  return check('dataforseo_auth', 'DataForSEO auth', 'ok', balance, { latencyMs });
}

export async function runConnectionHealth() {
  const checks = [];

  checks.push(await checkDataForSeoAuth());

  // Business Data (GMB DFS)
  if (!hasRealBusinessDataProvider()) {
    checks.push(
      check(
        'business_data',
        'Business Data (GMB via DataForSEO)',
        'fail',
        'DataForSEO credentials required for Local fallback'
      )
    );
  } else {
    const dfsProjects = await prisma.project.count({ where: { gmbCid: { not: null } } });
    checks.push(
      check(
        'business_data',
        'Business Data (GMB via DataForSEO)',
        dfsProjects > 0 ? 'ok' : 'warn',
        `Provider=${BUSINESS_DATA_PROVIDER}. ${dfsProjects} project(s) with manual GBP identifier (gmbCid).`,
        { projectsWithGmbCid: dfsProjects }
      )
    );
  }

  // SERP
  checks.push(
    hasRealSerpProvider()
      ? check('serp', 'SERP', 'ok', `Provider=${SERP_PROVIDER}`)
      : check('serp', 'SERP', 'warn', `Provider=${SERP_PROVIDER} (not configured for live SERP)`)
  );

  // Keywords
  checks.push(
    hasRealKeywordProvider()
      ? check('keywords', 'Keyword data', 'ok', `Provider=${KEYWORD_DATA_PROVIDER}`)
      : check('keywords', 'Keyword data', 'warn', `Provider=${KEYWORD_DATA_PROVIDER}`)
  );

  // Backlinks
  checks.push(
    hasRealBacklinkProvider()
      ? check('backlinks', 'Backlinks', 'ok', `Provider=${BACKLINK_PROVIDER}`)
      : check('backlinks', 'Backlinks', 'warn', `Provider=${BACKLINK_PROVIDER}`)
  );

  // OpenRouter
  if (!isOpenRouterConfigured()) {
    checks.push(check('openrouter', 'OpenRouter (AI Visibility)', 'fail', 'OPENROUTER_API_KEY not set'));
  } else {
    const { ok, error, latencyMs } = await timed(async () => {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY.trim()}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
      return res.json();
    });
    checks.push(
      ok
        ? check('openrouter', 'OpenRouter (AI Visibility)', 'ok', 'API key accepted', { latencyMs })
        : check('openrouter', 'OpenRouter (AI Visibility)', 'fail', error?.message || 'Ping failed', {
            latencyMs,
          })
    );
  }

  // Anthropic
  checks.push(
    isAiConfigured()
      ? check('anthropic', 'Anthropic (Claude)', 'ok', 'ANTHROPIC_API_KEY configured')
      : check('anthropic', 'Anthropic (Claude)', 'warn', 'ANTHROPIC_API_KEY not set — local query rewrite falls back to heuristic')
  );

  // Agency Google
  if (!isAgencyGoogleOAuthConfigured()) {
    checks.push(
      check('agency_google', 'Agency Google OAuth', 'warn', 'GOOGLE_CLIENT_ID / SECRET not configured')
    );
  } else {
    try {
      const status = await getAgencyConnectionStatus();
      const email = status.connection?.googleEmail;
      checks.push(
        status.connected
          ? check(
              'agency_google',
              'Agency Google OAuth',
              'ok',
              email ? `Connected as ${email}` : 'Connected'
            )
          : check(
              'agency_google',
              'Agency Google OAuth',
              'warn',
              status.serviceAccountFallback
                ? 'Not connected (service-account fallback may cover GSC)'
                : 'Not connected — link Google in Integrations'
            )
      );
    } catch (err) {
      checks.push(check('agency_google', 'Agency Google OAuth', 'fail', err.message));
    }
  }

  // Binding summary
  const projects = await prisma.project.findMany({
    where: { client: { isActive: true } },
    select: {
      gscSiteUrl: true,
      ga4PropertyId: true,
      gmbLocationId: true,
      gmbCid: true,
      dataforseoDomain: true,
      targetMarket: true,
    },
  });
  const summary = {
    total: projects.length,
    gsc: projects.filter((p) => p.gscSiteUrl).length,
    ga4: projects.filter((p) => p.ga4PropertyId).length,
    gmbNative: projects.filter((p) => p.gmbLocationId).length,
    gmbDfs: projects.filter((p) => p.gmbCid).length,
    domain: projects.filter((p) => p.dataforseoDomain).length,
    targetMarket: projects.filter((p) => p.targetMarket).length,
  };
  checks.push(
    check(
      'bindings',
      'Project bindings',
      summary.total === 0 ? 'warn' : 'ok',
      `${summary.total} active projects · GSC ${summary.gsc} · GA4 ${summary.ga4} · GMB native ${summary.gmbNative} · GMB DFS ${summary.gmbDfs} · domain ${summary.domain} · market ${summary.targetMarket}`,
      { summary }
    )
  );

  const okCount = checks.filter((c) => c.status === 'ok').length;
  const failCount = checks.filter((c) => c.status === 'fail').length;
  const warnCount = checks.filter((c) => c.status === 'warn').length;

  return {
    checkedAt: new Date().toISOString(),
    summary: { ok: okCount, warn: warnCount, fail: failCount },
    checks,
    dfsProjects: await prisma.project.findMany({
      where: { gmbCid: { not: null }, client: { isActive: true } },
      select: {
        id: true,
        name: true,
        gmbCid: true,
        gmbLocationName: true,
        targetMarket: true,
        gmbLastSyncedAt: true,
        client: { select: { agencyName: true } },
      },
      orderBy: [{ client: { agencyName: 'asc' } }, { name: 'asc' }],
      take: 50,
    }),
  };
}

export async function probeProjectGmbDfs(projectId) {
  if (!hasRealBusinessDataProvider()) {
    return {
      status: 'fail',
      message: 'DataForSEO credentials not configured',
    };
  }
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      gmbCid: true,
      gmbLocationName: true,
      targetMarket: true,
      client: { select: { agencyName: true } },
    },
  });
  if (!project) {
    return { status: 'fail', message: 'Project not found' };
  }
  if (!project.gmbCid) {
    return {
      status: 'fail',
      message: 'No gmbCid / Maps identifier on this project — set it in Integrations',
      projectId,
    };
  }

  const identifier = dfsKeywordForProject(project);
  const { ok, result, error, latencyMs } = await timed(() => fetchGmbInfo({ identifier }));
  if (!ok) {
    return {
      status: 'fail',
      message: error?.message || 'DataForSEO Business Info failed',
      projectId,
      identifier,
      latencyMs,
    };
  }
  if (!result) {
    return {
      status: 'warn',
      message: 'No business found for this identifier — try CID, place_id, or "Name City"',
      projectId,
      identifier,
      latencyMs,
    };
  }
  return {
    status: 'ok',
    message: `Found “${result.title || 'business'}” · rating ${result.rating ?? '—'} · reviews ${result.reviewsCount ?? '—'}`,
    projectId,
    identifier,
    latencyMs,
    profile: result,
  };
}
