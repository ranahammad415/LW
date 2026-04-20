/**
 * Metric calculation engine for Google Search Console data.
 *
 * Takes raw GSC rows (current period + previous period) and computes
 * the 5 client dashboard key metrics.
 *
 * Each row: { keys: string[], clicks: number, impressions: number, ctr: number, position: number }
 */

/**
 * Expected CTR by position (industry benchmarks for organic search).
 * Position 1 ~= 28%, position 2 ~= 15%, etc.
 */
const EXPECTED_CTR_BY_POSITION = {
  1: 0.28,
  2: 0.15,
  3: 0.11,
  4: 0.08,
  5: 0.06,
  6: 0.045,
  7: 0.035,
  8: 0.03,
  9: 0.025,
  10: 0.02,
};

function getExpectedCtr(position) {
  const rounded = Math.min(Math.max(Math.round(position), 1), 10);
  return EXPECTED_CTR_BY_POSITION[rounded] ?? 0.01;
}

/**
 * Calculate all 5 dashboard metrics from GSC data.
 *
 * @param {Array} currentRows - GSC rows for the current period (last 7 days)
 * @param {Array} previousRows - GSC rows for the previous period (7 days before that)
 * @returns {Array<{metricType: string, value: string, change: string|null}>}
 */
export function calculateMetrics(currentRows, previousRows) {
  const metrics = [];

  // ─── Master Visibility (0-100) ───
  // Weighted avg position normalized to 0-100 scale.
  // Position 1 = 100, position 50+ = ~0. Weighted by impressions.
  const masterVisibility = calcMasterVisibility(currentRows, previousRows);
  metrics.push(masterVisibility);

  // ─── Growth Index ───
  // Impressions trend: current vs previous period
  const growthIndex = calcGrowthIndex(currentRows, previousRows);
  metrics.push(growthIndex);

  // ─── Competitor Threat ───
  // Position volatility — how much positions shifted between periods
  const competitorThreat = calcCompetitorThreat(currentRows, previousRows);
  metrics.push(competitorThreat);

  // ─── Content Gap ───
  // Queries with high impressions but low/zero clicks
  const contentGap = calcContentGap(currentRows);
  metrics.push(contentGap);

  // ─── AI Search Readiness ───
  // CTR performance vs expected CTR benchmarks
  const aiReadiness = calcAiSearchReadiness(currentRows);
  metrics.push(aiReadiness);

  return metrics;
}

function calcMasterVisibility(currentRows, previousRows) {
  const score = visibilityScore(currentRows);
  const prevScore = visibilityScore(previousRows);
  const diff = score - prevScore;
  const diffStr = diff >= 0 ? `+${diff} pts` : `${diff} pts`;

  return {
    metricType: 'MASTER_VISIBILITY',
    value: `${score}/100`,
    change: diffStr !== '+0 pts' && diffStr !== '0 pts' ? `▲ ${diffStr}` : '✓ Stable',
  };
}

function visibilityScore(rows) {
  if (!rows || rows.length === 0) return 0;

  let totalWeightedScore = 0;
  let totalImpressions = 0;

  for (const row of rows) {
    const imp = row.impressions || 0;
    const pos = row.position || 100;
    // Normalize position to 0-100: position 1 = 100, position 100 = 0
    const posScore = Math.max(0, Math.round(100 - (pos - 1)));
    totalWeightedScore += posScore * imp;
    totalImpressions += imp;
  }

  if (totalImpressions === 0) return 0;
  return Math.round(totalWeightedScore / totalImpressions);
}

function calcGrowthIndex(currentRows, previousRows) {
  const currentImpressions = sumField(currentRows, 'impressions');
  const prevImpressions = sumField(previousRows, 'impressions');

  if (prevImpressions === 0) {
    return {
      metricType: 'GROWTH_INDEX',
      value: currentImpressions > 0 ? 'Growing' : 'No data',
      change: currentImpressions > 0 ? 'New' : null,
    };
  }

  const pctChange = ((currentImpressions - prevImpressions) / prevImpressions) * 100;
  const rounded = Math.round(pctChange * 10) / 10;

  let label;
  if (pctChange >= 5) label = 'Growing';
  else if (pctChange <= -5) label = 'Declining';
  else label = 'Stable';

  return {
    metricType: 'GROWTH_INDEX',
    value: label,
    change: `${rounded >= 0 ? '+' : ''}${rounded}%`,
  };
}

function calcCompetitorThreat(currentRows, previousRows) {
  // Build a map of query -> position for both periods
  const currentMap = new Map();
  for (const row of currentRows) {
    const query = row.keys?.[0];
    if (query) currentMap.set(query, row.position);
  }

  const prevMap = new Map();
  for (const row of previousRows) {
    const query = row.keys?.[0];
    if (query) prevMap.set(query, row.position);
  }

  // Calculate position changes for overlapping queries
  const diffs = [];
  for (const [query, curPos] of currentMap) {
    const prevPos = prevMap.get(query);
    if (prevPos !== undefined) {
      diffs.push(Math.abs(curPos - prevPos));
    }
  }

  if (diffs.length === 0) {
    return {
      metricType: 'COMPETITOR_THREAT',
      value: 'N/A',
      change: 'Insufficient data',
    };
  }

  // Standard deviation of position changes
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const variance = diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / diffs.length;
  const stdDev = Math.sqrt(variance);

  let level;
  if (stdDev < 2) level = 'LOW';
  else if (stdDev < 5) level = 'MEDIUM';
  else level = 'HIGH';

  return {
    metricType: 'COMPETITOR_THREAT',
    value: level,
    change: level === 'LOW' ? '✓ Stable' : `±${Math.round(stdDev * 10) / 10} pos`,
  };
}

function calcContentGap(currentRows) {
  if (!currentRows || currentRows.length === 0) {
    return {
      metricType: 'CONTENT_GAP',
      value: '0%',
      change: 'No data',
    };
  }

  // Queries with impressions > 10 but CTR < 2% (high impression, low engagement)
  const highImpLowCtr = currentRows.filter(
    (r) => r.impressions >= 10 && r.ctr < 0.02
  );

  const totalQueries = currentRows.length;
  const gapCount = highImpLowCtr.length;
  const gapPct = Math.round((gapCount / totalQueries) * 100);

  return {
    metricType: 'CONTENT_GAP',
    value: `${gapPct}%`,
    change: `${gapCount} opps`,
  };
}

function calcAiSearchReadiness(currentRows) {
  if (!currentRows || currentRows.length === 0) {
    return {
      metricType: 'AI_SEARCH_READINESS',
      value: '0/100',
      change: 'No data',
    };
  }

  // Compare actual CTR vs expected CTR for each query's position
  let totalScore = 0;
  let count = 0;

  for (const row of currentRows) {
    if (row.impressions < 5) continue; // Skip very low impression queries
    const expectedCtr = getExpectedCtr(row.position);
    const actualCtr = row.ctr || 0;

    // Ratio of actual to expected: 1.0 = meeting benchmark, >1 = exceeding
    const ratio = expectedCtr > 0 ? actualCtr / expectedCtr : 0;
    // Cap at 2.0 (200%) to avoid outliers skewing the score
    const cappedRatio = Math.min(ratio, 2.0);
    // Convert to 0-100 scale: ratio of 1.0 = 50, ratio of 2.0 = 100
    const queryScore = Math.round(cappedRatio * 50);
    totalScore += queryScore;
    count++;
  }

  if (count === 0) {
    return {
      metricType: 'AI_SEARCH_READINESS',
      value: '0/100',
      change: 'No data',
    };
  }

  const avgScore = Math.round(totalScore / count);
  const capped = Math.min(avgScore, 100);

  let label;
  if (capped >= 70) label = 'Strong';
  else if (capped >= 40) label = 'Developing';
  else label = 'Needs work';

  return {
    metricType: 'AI_SEARCH_READINESS',
    value: `${capped}/100`,
    change: label,
  };
}

function sumField(rows, field) {
  if (!rows || rows.length === 0) return 0;
  return rows.reduce((sum, r) => sum + (r[field] || 0), 0);
}
