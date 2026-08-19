/**
 * Chart-series helpers shared by GSC / GA4 / GMB builders.
 *
 * Densify fills every calendar day with 0 so compare windows can be
 * index-zipped. Trailing zeros are usually "data not ready yet" (GSC/GA4 lag),
 * not a real traffic crash — strip them before sending series to charts.
 */

export const TRAILING_INCOMPLETE_MAX_DAYS = 7;

function isActiveRow(row, activityKeys) {
  return activityKeys.some((k) => Number(row?.[k]) > 0);
}

/**
 * Drop a short suffix of days with no activity.
 * Cap how many days we drop so a genuine multi-day collapse stays visible.
 * If the whole series is empty, leave it unchanged.
 *
 * @param {Array<Record<string, unknown>>} series
 * @param {string[]} activityKeys
 * @param {{ maxDays?: number }} [opts]
 * @returns {Array<Record<string, unknown>>}
 */
export function stripTrailingIncomplete(series, activityKeys, opts = {}) {
  const maxDays = opts.maxDays ?? TRAILING_INCOMPLETE_MAX_DAYS;
  if (!Array.isArray(series) || series.length === 0) return series;
  if (!Array.isArray(activityKeys) || activityKeys.length === 0) return series;

  let end = series.length;
  let trimmed = 0;
  while (end > 0 && trimmed < maxDays && !isActiveRow(series[end - 1], activityKeys)) {
    end -= 1;
    trimmed += 1;
  }
  if (trimmed === 0) return series;
  if (end === 0) return series;

  const prefixHasActivity = series.slice(0, end).some((row) => isActiveRow(row, activityKeys));
  if (!prefixHasActivity) return series;

  return series.slice(0, end);
}
