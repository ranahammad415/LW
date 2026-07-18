/**
 * Minimal shared DataForSEO client.
 *
 * Centralizes Basic-auth + JSON POST/GET so the various providers
 * (SERP, keywords, backlinks, business data) don't each re-implement it.
 * Credentials are read from env at call time: DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD.
 */

const BASE_URL = 'https://api.dataforseo.com';

function authHeader() {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) {
    throw new Error('DataForSEO credentials are not configured');
  }
  return `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;
}

/**
 * POST a task array to a DataForSEO endpoint path (e.g. "/v3/business_data/...").
 * Returns the parsed JSON payload.
 */
export async function postDataForSeo(path, tasks) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(tasks),
  });
  if (!res.ok) throw new Error(`DataForSEO ${res.status}`);
  return res.json();
}

/**
 * GET a DataForSEO endpoint path (e.g. a task_get URL). Returns parsed JSON.
 */
export async function getDataForSeo(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'GET',
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`DataForSEO ${res.status}`);
  return res.json();
}
