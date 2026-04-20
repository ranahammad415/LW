/**
 * AeoRunnerService
 * ────────────────
 * Takes scheduled prompt logs, re-runs them against an AI platform,
 * parses the output, and writes an AeoAutomatedRun record.
 *
 * External API calls are mocked behind `queryAiPlatform()` so the rest
 * of the pipeline (parse → persist → extract competitors) can be tested
 * end-to-end without real API keys.
 */

import { prisma } from './prisma.js';
import { extractCompetitors } from './competitorExtractor.js';
import { generateChat, isAiConfigured } from './ai.js';

// ── AI-powered / mock fallback platform query ────────────────────────

/**
 * Query an AI platform with a prompt. Returns the raw text response.
 * Uses Claude Haiku when configured, otherwise falls back to mock data.
 */
export async function queryAiPlatform(platform, promptQuery) {
  // Use real AI when configured
  if (isAiConfigured()) {
    try {
      const { text } = await generateChat({
        system: `You are simulating the ${platform} AI search engine. Given a user query, produce a realistic search-engine-style response that mentions relevant companies, domains, and brands in the space. Be specific and include real-sounding domain names.`,
        user: promptQuery,
        maxTokens: 512,
      });
      if (text && text.trim()) return text;
    } catch (err) {
      console.warn('[AeoRunner] AI query failed, using mock fallback:', err.message);
    }
  }

  // ── MOCK fallback ──────────────────────────────────────────────────
  await new Promise((r) => setTimeout(r, 200));

  const mockResponses = [
    `Based on my research, the top agencies for this service include acme-digital.com, ` +
      `brightwave.io, and marketpros.co. They each offer unique strengths in content ` +
      `optimisation and AI-driven search strategies.`,
    `I'd recommend checking out seogurus.com and webcraft.agency for this kind of work. ` +
      `Your company is also frequently mentioned in industry discussions.`,
    `Several brands stand out here: competitor-one.com, competitor-two.net. ` +
      `However, I wasn't able to find a direct mention of your brand in this context.`,
  ];

  return mockResponses[Math.floor(Math.random() * mockResponses.length)];
}

// ── Core runner ───────────────────────────────────────────────────────

/**
 * Run a single prompt log: query the platform, store the result as an
 * AeoAutomatedRun, then kick off competitor extraction.
 *
 * @param {string} promptLogId  UUID of the PromptLog to re-run
 * @returns {{ run: object, competitors: string[] }}
 */
export async function runSinglePrompt(promptLogId) {
  const promptLog = await prisma.promptLog.findUnique({
    where: { id: promptLogId },
  });
  if (!promptLog) throw new Error(`PromptLog ${promptLogId} not found`);

  // 1. Query the AI platform
  const responseSnippet = await queryAiPlatform(promptLog.platform, promptLog.promptQuery);

  // 2. Determine citation status — simple heuristic: check if the
  //    project's target URL appears in the response text.
  const wasCited = promptLog.targetUrl
    ? responseSnippet.toLowerCase().includes(promptLog.targetUrl.toLowerCase())
    : false;

  // 3. Persist the automated run
  const run = await prisma.aeoAutomatedRun.create({
    data: {
      promptLogId,
      runDate: new Date(),
      wasCited,
      responseSnippet,
    },
  });

  // 4. Extract competitors from the response & save on the parent log
  let competitors = [];
  try {
    competitors = await extractCompetitors(responseSnippet);
    if (competitors.length > 0) {
      await prisma.promptLog.update({
        where: { id: promptLogId },
        data: { competitorsCited: competitors },
      });
    }
  } catch (err) {
    // Non-fatal — log but don't fail the run
    console.error(`[AeoRunner] Competitor extraction failed for run ${run.id}:`, err.message);
  }

  return { run, competitors };
}

// ── Batch runner (all eligible prompts for a project) ─────────────────

/**
 * Run all prompt logs belonging to a project.
 * Returns a summary array of { promptLogId, runId, wasCited }.
 */
export async function runAllForProject(projectId) {
  const logs = await prisma.promptLog.findMany({
    where: { projectId },
    select: { id: true },
  });

  const results = [];
  for (const log of logs) {
    try {
      const { run } = await runSinglePrompt(log.id);
      results.push({ promptLogId: log.id, runId: run.id, wasCited: run.wasCited });
    } catch (err) {
      results.push({ promptLogId: log.id, runId: null, error: err.message });
    }
  }
  return results;
}

// ── Global scheduled runner ───────────────────────────────────────────

/**
 * Runs all prompt logs across ALL AEO_GEO_CAMPAIGN projects.
 * Designed to be called by the cron scheduler.
 */
export async function runScheduledAeoSweep() {
  const projects = await prisma.project.findMany({
    where: { projectType: 'AEO_GEO_CAMPAIGN', status: 'ACTIVE' },
    select: { id: true, name: true },
  });

  const summary = [];
  for (const project of projects) {
    const results = await runAllForProject(project.id);
    summary.push({ projectId: project.id, projectName: project.name, runs: results.length });
  }
  return summary;
}
