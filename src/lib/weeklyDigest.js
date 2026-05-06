/**
 * Weekly client digest — AI-generated summary of the last 7 days of activity.
 * Runs weekly (cron) and creates ClientPMUpdate rows authored by the "system"
 * PM (leadPm fallback) so they show up in the existing client updates feed.
 *
 * Non-fatal: any per-client failure is logged and the loop continues.
 */

import { prisma } from './prisma.js';
import { generateChat, isAiConfigured } from './ai.js';
import { notify } from './notificationService.js';

const SYSTEM_PROMPT = `You are a Senior SEO Account Manager writing a concise weekly digest for a client. Tone: warm, confident, business-focused. No AI filler ("delve", "in today's digital landscape", "furthermore"). Output 3-6 short bullet points. Cover:
- What the team shipped this week (completed tasks, deliverables)
- Notable signals (rank changes, wins, issues)
- What's coming next (top 1-2 items in flight)
Return strictly valid JSON: { "headline": "<one-line summary>", "bullets": ["..."] }`;

function formatTasks(tasks) {
  if (!tasks.length) return 'No tasks completed this week.';
  return tasks.map((t) => `- [${t.taskType}] ${t.title}`).join('\n');
}

function formatRankChanges(rankRows) {
  if (!rankRows.length) return 'No ranking data this week.';
  return rankRows
    .slice(0, 10)
    .map((r) => `- ${r.keyword}: now #${r.position ?? 'n/a'}`)
    .join('\n');
}

async function buildDigestForClient(client) {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [completedTasks, newDeliverables] = await Promise.all([
    prisma.task.findMany({
      where: {
        project: { clientId: client.id },
        status: 'COMPLETED',
        updatedAt: { gte: weekAgo },
        clientVisible: true,
      },
      select: { title: true, taskType: true },
      take: 25,
    }),
    prisma.deliverableVersion.count({
      where: {
        task: { project: { clientId: client.id } },
        createdAt: { gte: weekAgo },
      },
    }),
  ]);

  // Optional rank context — OmniSearchRankHistory is keyed by keyword.projectId,
  // which is OmniSearchProject (separate from core Project). Skip if none exist.
  let rankContext = [];
  try {
    rankContext = await prisma.omniSearchRankHistory.findMany({
      where: { checkedAt: { gte: weekAgo } },
      select: { position: true, keyword: { select: { keyword: true } } },
      take: 10,
      orderBy: { checkedAt: 'desc' },
    }).then((rows) => rows.map((r) => ({ keyword: r.keyword?.keyword || '', position: r.position })));
  } catch (_) {
    rankContext = [];
  }

  const userMessage = `Client: ${client.agencyName}
Reporting window: last 7 days

Completed tasks:
${formatTasks(completedTasks)}

New deliverables uploaded this week: ${newDeliverables}

Recent rank snapshots:
${formatRankChanges(rankContext)}`;

  const { parsed, text } = await generateChat({
    system: SYSTEM_PROMPT,
    user: userMessage,
    json: true,
    maxTokens: 800,
    temperature: 0.5,
    feature: 'weekly_client_digest',
    clientId: client.id,
  });

  const result = parsed || (() => {
    try { return JSON.parse(text); } catch { return null; }
  })();

  if (!result || !Array.isArray(result.bullets)) return null;
  return {
    headline: String(result.headline || `Weekly update for ${client.agencyName}`).slice(0, 300),
    bullets: result.bullets.map((b) => String(b).slice(0, 500)).slice(0, 8),
  };
}

function renderMarkdown(digest) {
  const lines = [`**${digest.headline}**`, '', ...digest.bullets.map((b) => `- ${b}`)];
  return lines.join('\n');
}

export async function runWeeklyClientDigest(logger) {
  if (!isAiConfigured()) {
    logger?.info?.('Weekly digest skipped: ANTHROPIC_API_KEY not set');
    return { skipped: true, reason: 'ai_not_configured' };
  }

  const clients = await prisma.clientAccount.findMany({
    where: { isActive: true },
    select: { id: true, agencyName: true, leadPmId: true },
  });

  const summary = { total: clients.length, created: 0, failed: 0 };

  for (const client of clients) {
    try {
      const digest = await buildDigestForClient(client);
      if (!digest) {
        continue;
      }
      const authorId = client.leadPmId;
      if (!authorId) {
        // No PM to author-as; skip silently.
        continue;
      }
      const message = renderMarkdown(digest);
      const update = await prisma.clientPMUpdate.create({
        data: {
          clientId: client.id,
          authorId,
          message: message.slice(0, 10000),
        },
      });
      summary.created += 1;

      // Notify the client users who can see updates.
      try {
        const clientUsers = await prisma.clientUser.findMany({
          where: { clientId: client.id },
          select: { userId: true },
        });
        if (clientUsers.length > 0) {
          notify({
            slug: 'client_weekly_digest',
            recipientIds: clientUsers.map((cu) => cu.userId),
            variables: { clientName: client.agencyName, headline: digest.headline },
            actionUrl: '/portal/client',
            metadata: { updateId: update.id, kind: 'ai_weekly_digest' },
          }).catch(() => {});
        }
      } catch (_) {}
    } catch (err) {
      summary.failed += 1;
      logger?.warn?.({ err, clientId: client.id }, 'Weekly digest failed for client');
    }
  }
  return summary;
}
