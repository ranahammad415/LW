import { prisma } from '../../lib/prisma.js';

// Rough cost estimate for Claude Haiku (USD per 1M tokens). Kept conservative.
const COST_PER_MTOK_IN = Number(process.env.AI_COST_PER_MTOK_IN || 1.00);
const COST_PER_MTOK_OUT = Number(process.env.AI_COST_PER_MTOK_OUT || 5.00);

function estimateCost(tokensIn, tokensOut) {
  return (
    (tokensIn / 1_000_000) * COST_PER_MTOK_IN +
    (tokensOut / 1_000_000) * COST_PER_MTOK_OUT
  );
}

export async function adminAiUsageRoutes(app) {
  // GET /admin/ai/usage?days=30
  app.get(
    '/ai/usage',
    { onRequest: [app.verifyJwt, app.requireOwner] },
    async (request, reply) => {
      const days = Math.max(1, Math.min(Number(request.query?.days) || 30, 365));
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const rows = await prisma.aiUsageLog.findMany({
        where: { createdAt: { gte: since } },
        select: {
          feature: true,
          tokensIn: true,
          tokensOut: true,
          latencyMs: true,
          success: true,
          errorCode: true,
          createdAt: true,
        },
      });

      // Aggregate by feature
      const byFeature = new Map();
      for (const r of rows) {
        const f = r.feature || 'unspecified';
        if (!byFeature.has(f)) {
          byFeature.set(f, {
            feature: f,
            calls: 0,
            successCalls: 0,
            errorCalls: 0,
            tokensIn: 0,
            tokensOut: 0,
            totalLatencyMs: 0,
          });
        }
        const g = byFeature.get(f);
        g.calls += 1;
        if (r.success) g.successCalls += 1;
        else g.errorCalls += 1;
        g.tokensIn += r.tokensIn || 0;
        g.tokensOut += r.tokensOut || 0;
        g.totalLatencyMs += r.latencyMs || 0;
      }

      const features = Array.from(byFeature.values())
        .map((g) => ({
          feature: g.feature,
          calls: g.calls,
          successCalls: g.successCalls,
          errorCalls: g.errorCalls,
          tokensIn: g.tokensIn,
          tokensOut: g.tokensOut,
          avgLatencyMs: g.calls ? Math.round(g.totalLatencyMs / g.calls) : 0,
          errorRate: g.calls ? Math.round((g.errorCalls / g.calls) * 1000) / 10 : 0, // % with 1dp
          estimatedCostUsd: Number(estimateCost(g.tokensIn, g.tokensOut).toFixed(4)),
        }))
        .sort((a, b) => b.calls - a.calls);

      // Daily totals (by day string)
      const byDay = new Map();
      for (const r of rows) {
        const day = r.createdAt.toISOString().slice(0, 10);
        if (!byDay.has(day)) byDay.set(day, { day, calls: 0, tokensIn: 0, tokensOut: 0 });
        const d = byDay.get(day);
        d.calls += 1;
        d.tokensIn += r.tokensIn || 0;
        d.tokensOut += r.tokensOut || 0;
      }
      const daily = Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));

      const totals = features.reduce(
        (acc, f) => {
          acc.calls += f.calls;
          acc.successCalls += f.successCalls;
          acc.errorCalls += f.errorCalls;
          acc.tokensIn += f.tokensIn;
          acc.tokensOut += f.tokensOut;
          acc.estimatedCostUsd += f.estimatedCostUsd;
          return acc;
        },
        { calls: 0, successCalls: 0, errorCalls: 0, tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0 }
      );
      totals.estimatedCostUsd = Number(totals.estimatedCostUsd.toFixed(4));

      return reply.send({
        windowDays: days,
        totals,
        features,
        daily,
      });
    }
  );
}
