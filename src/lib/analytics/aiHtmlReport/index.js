/**
 * Orchestrate AI HTML performance report generation.
 */
import { aggregateReportFacts } from './aggregateFacts.js';
import { generateReportNarrative } from './generateNarrative.js';
import { buildReportFileName, renderPerformanceHtml } from './renderHtml.js';
import { isAiConfigured } from '../../ai.js';

/**
 * @param {{
 *   clientIds: string[],
 *   start: string,
 *   end: string,
 *   compare?: boolean,
 *   userId?: string,
 * }} opts
 * @returns {Promise<{ html: string, fileName: string, range: object, meta: object } | { error: object }>}
 */
export async function generateAiHtmlReport(opts) {
  const { clientIds, start, end, compare = true, userId } = opts || {};

  if (!start || !end) {
    return { error: { status: 400, message: 'start and end dates are required (YYYY-MM-DD)' } };
  }

  if (!isAiConfigured()) {
    return {
      error: {
        status: 503,
        message: 'AI is not configured. Set ANTHROPIC_API_KEY in the server environment.',
      },
    };
  }

  const agg = await aggregateReportFacts({ clientIds, start, end, compare });
  if (agg.error) return { error: agg.error };

  const { facts } = agg;
  let narrative;
  try {
    narrative = await generateReportNarrative(facts.factsForAi, {
      userId,
      clientId: clientIds[0],
    });
  } catch (err) {
    const status = err?.status === 503 ? 503 : 502;
    return {
      error: {
        status,
        message: err?.message || 'AI narrative generation failed',
      },
    };
  }

  const html = renderPerformanceHtml({ facts, narrative });
  const fileName = buildReportFileName(facts.brandName, facts.range?.start || start, facts.range?.end || end);

  return {
    html,
    fileName,
    range: {
      current: facts.range,
      previous: facts.prevRange,
    },
    meta: {
      brandName: facts.brandName,
      sources: facts.sources,
      healthScore: facts.healthScore,
      winCount: facts.wins?.length ?? 0,
      weakCount: facts.weaks?.length ?? 0,
    },
  };
}
