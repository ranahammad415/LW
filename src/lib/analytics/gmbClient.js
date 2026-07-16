/**
 * Google Business Profile Performance + Reviews clients (agency OAuth).
 */
import { getAgencyOAuth2Client } from './googleAuth.js';

const PERF_BASE = 'https://businessprofileperformance.googleapis.com/v1';
const MYBUSINESS_BASE = 'https://mybusiness.googleapis.com/v4';

async function authHeaders() {
  const client = await getAgencyOAuth2Client();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Failed to obtain Google access token');
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
}

/**
 * Daily metrics for a location over a date range.
 * locationName like "locations/123" or full "accounts/x/locations/y"
 */
export async function fetchGmbDailyMetrics(locationResourceName, startDate, endDate) {
  const headers = await authHeaders();
  // Normalize to locations/{id} for Performance API
  const locMatch = String(locationResourceName).match(/locations\/[^/]+$/);
  const locationName = locMatch ? locMatch[0] : locationResourceName.replace(/^accounts\/[^/]+\//, '');

  const dailyMetrics = [
    'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
    'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
    'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
    'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
    'WEBSITE_CLICKS',
    'CALL_CLICKS',
    'BUSINESS_DIRECTION_REQUESTS',
  ];

  const byDate = new Map();

  for (const metric of dailyMetrics) {
    const url = new URL(`${PERF_BASE}/${locationName}:fetchMultiDailyMetricsTimeSeries`);
    // Prefer single-metric fetchMulti via query params used by Performance API
    const singleUrl = `${PERF_BASE}/${locationName}:getDailyMetricsTimeSeries?dailyMetric=${metric}&dailyRange.start_date.year=${startDate.getUTCFullYear()}&dailyRange.start_date.month=${startDate.getUTCMonth() + 1}&dailyRange.start_date.day=${startDate.getUTCDate()}&dailyRange.end_date.year=${endDate.getUTCFullYear()}&dailyRange.end_date.month=${endDate.getUTCMonth() + 1}&dailyRange.end_date.day=${endDate.getUTCDate()}`;

    const res = await fetch(singleUrl, { headers });
    if (!res.ok) {
      // Soft-fail individual metrics
      continue;
    }
    const json = await res.json();
    const series = json.timeSeries?.datedValues || json.dailyMetricTimeSeries?.[0]?.timeSeries?.datedValues || [];
    for (const point of series) {
      const d = point.date;
      if (!d) continue;
      const key = `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
      const acc = byDate.get(key) || {
        date: key,
        impressions: 0,
        impressionsSearch: 0,
        impressionsMaps: 0,
        websiteClicks: 0,
        directions: 0,
        calls: 0,
      };
      const val = Number(point.value || 0);
      if (metric.includes('SEARCH')) {
        acc.impressionsSearch += val;
        acc.impressions += val;
      } else if (metric.includes('MAPS')) {
        acc.impressionsMaps += val;
        acc.impressions += val;
      } else if (metric === 'WEBSITE_CLICKS') acc.websiteClicks += val;
      else if (metric === 'CALL_CLICKS') acc.calls += val;
      else if (metric === 'BUSINESS_DIRECTION_REQUESTS') acc.directions += val;
      byDate.set(key, acc);
    }
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * List reviews for a location (legacy mybusiness v4).
 * @param {string} accountId
 * @param {string} locationId - full or bare
 */
export async function fetchGmbReviews(accountId, locationId) {
  const headers = await authHeaders();
  let loc = locationId;
  if (!loc.includes('locations/')) loc = `locations/${loc}`;
  if (!loc.startsWith('accounts/')) {
    const acct = accountId.includes('accounts/') ? accountId : `accounts/${accountId}`;
    loc = `${acct}/${loc.replace(/^accounts\/[^/]+\//, '')}`;
  }
  const url = `${MYBUSINESS_BASE}/${loc}/reviews?pageSize=100`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GMB reviews failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  const starMap = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
  return (json.reviews || []).map((r) => ({
    reviewId: r.reviewId || r.name,
    reviewerName: r.reviewer?.displayName || null,
    starRating: starMap[r.starRating] || Number(r.starRating) || 0,
    comment: r.comment || null,
    replyComment: r.reviewReply?.comment || null,
    createTime: r.createTime ? new Date(r.createTime) : null,
    updateTime: r.updateTime ? new Date(r.updateTime) : null,
  }));
}
