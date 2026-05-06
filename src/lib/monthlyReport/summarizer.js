import { generateChat, isAiConfigured } from '../ai.js';

/**
 * System prompts for each report scope. Claude is asked to return a single
 * JSON object with a fixed shape so the UI can render it reliably.
 */
const PROJECT_SYSTEM = `You are a senior agency project manager writing a monthly project status report for the agency owner.
Input is a JSON "facts" payload from the CRM. Your job is to turn it into a business-quality report.

Return ONLY valid JSON matching this schema:
{
  "executiveSummary": string,         // 2-4 sentences, plain English
  "highlights": string[],             // 3-6 bullets, most impressive wins
  "risksAndBlockers": string[],       // 2-5 bullets, what's at risk or slipping
  "metrics": {                        // flat key-value pairs suitable for a dashboard grid
    [key: string]: string | number
  },
  "improvements": string[],           // 2-5 bullets on process/quality improvements shipped
  "nextMonthFocus": string[],         // 3-5 bullets with specific focus areas for next month
  "narrativeMarkdown": string         // a full polished markdown report combining all the above,
                                      // with sections (## Executive summary, ## Highlights,
                                      // ## Risks & blockers, ## Metrics, ## Improvements,
                                      // ## Focus for next month)
}
Write in a confident, direct tone. Call out specific numbers. Never invent data not present in the facts.`;

const AGENCY_SYSTEM = `You are the Chief of Staff for a digital agency writing the monthly agency-wide rollup report for the owner.
Input is a JSON "facts" payload aggregated across all projects. Produce a leadership-grade report.

Return ONLY valid JSON matching this schema:
{
  "executiveSummary": string,
  "highlights": string[],
  "risksAndBlockers": string[],
  "metrics": { [key: string]: string | number },
  "improvements": string[],
  "nextMonthFocus": string[],
  "narrativeMarkdown": string
}
The narrativeMarkdown should read like a CEO briefing: short, sharp, numeric, with actionable recommendations.`;

function buildFallbackNarrative(facts) {
  const lines = [];
  const isAgency = facts.scope === 'AGENCY';
  const title = isAgency ? 'Agency Monthly Activity' : `Project Monthly Activity — ${facts.project?.name ?? ''}`;
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`_AI narrative unavailable (ANTHROPIC_API_KEY not configured). Showing raw metrics._`);
  lines.push('');
  lines.push('## Metrics');
  const push = (label, val) => lines.push(`- **${label}:** ${val}`);
  if (isAgency) {
    push('Active clients', facts.overview.activeClients);
    push('Total projects', facts.overview.totalProjects);
    push('Tasks created', facts.tasks.created);
    push('Tasks completed', facts.tasks.completed);
    push('Tasks still open', facts.tasks.stillOpen);
    push('Issues opened / resolved', `${facts.issues.opened} / ${facts.issues.resolved}`);
    push('Standups logged', facts.standups.totalEntries);
    push('Blockers reported', facts.standups.blockersReported);
    push('Keyword suggestions', facts.seoAeo.keywordSuggestionsNew);
    push('AI citations', facts.seoAeo.citations);
    push('Notifications sent / read', `${facts.notifications.sent} / ${facts.notifications.read}`);
  } else {
    push('Tasks created', facts.tasks.created);
    push('Tasks completed', facts.tasks.completed);
    push('Tasks still open', facts.tasks.stillOpen);
    push('Tasks overdue', facts.tasks.overdue);
    push('Standups', facts.standups.totalEntries);
    push('Blockers reported', facts.standups.blockersReported);
    push('Content reviews started / published', `${facts.content.reviewsStarted} / ${facts.content.reviewsPublished}`);
    push(
      'Keyword suggestions new / accepted / rejected',
      `${facts.seoAeo.keywordSuggestionsNew} / ${facts.seoAeo.keywordSuggestionsAccepted} / ${facts.seoAeo.keywordSuggestionsRejected}`
    );
    push('Prompt logs / citations', `${facts.seoAeo.promptLogs} / ${facts.seoAeo.promptCitations}`);
    push('Issues opened / resolved', `${facts.issues.opened} / ${facts.issues.resolved}`);
    push('Client activity events', facts.clientActivity.totalEvents);
    push('Notifications sent / read', `${facts.notifications.sent} / ${facts.notifications.read}`);
  }
  return lines.join('\n');
}

function buildFallbackReport(facts) {
  const narrativeMarkdown = buildFallbackNarrative(facts);
  return {
    aiJson: null,
    narrativeMd: narrativeMarkdown,
  };
}

/**
 * Summarize facts via Claude. Returns { aiJson, narrativeMd }.
 * Falls back to a deterministic metrics-only report when AI is not configured.
 */
export async function summarize(facts) {
  if (!isAiConfigured()) {
    return buildFallbackReport(facts);
  }

  const system = facts.scope === 'AGENCY' ? AGENCY_SYSTEM : PROJECT_SYSTEM;
  const user = `Facts payload for the reporting period:\n\n${JSON.stringify(facts, null, 2)}`;

  try {
    const { parsed, text } = await generateChat({
      system,
      user,
      json: true,
      temperature: 0.4,
      maxTokens: 4096,
      feature: 'monthly_activity_report',
    });

    if (parsed && typeof parsed === 'object' && parsed.narrativeMarkdown) {
      return {
        aiJson: parsed,
        narrativeMd: parsed.narrativeMarkdown,
      };
    }

    // AI returned something but JSON parse failed — keep raw text as narrative.
    if (text && text.trim().length > 0) {
      return { aiJson: null, narrativeMd: text };
    }
  } catch (err) {
    // Fall through to deterministic fallback on any AI error.
  }

  return buildFallbackReport(facts);
}
