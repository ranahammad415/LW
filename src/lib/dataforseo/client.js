/**
 * Minimal shared DataForSEO client.
 *
 * Centralizes Basic-auth + JSON POST/GET so the various providers
 * (SERP, keywords, backlinks, business data) don't each re-implement it.
 * Credentials are read from env at call time: DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD.
 *
 * Two layers:
 * - postDataForSeo / getDataForSeo: raw payload (HTTP errors and timeouts throw). Callers that parse codes themselves
 *   (backlinkSnapshots, llmMentions, connectionHealth) keep using these.
 * - dfsPostTask / dfsGetTask + parseDfsTask: one task, checked at the top level AND the task level. DataForSEO answers
 *   HTTP 200 for most failures and puts the real outcome in `status_code` (docs.dataforseo.com/v3/appendix/errors):
 *   20000 ok, 20100 task created, 40601 task handed / 40602 task in queue (pending, not an error), 40102 no search
 *   results, 401xx / 402xx account level (auth, payment, rate limit), ≥ 50000 server side.
 * Every call has a hard timeout (DATAFORSEO_TIMEOUT_MS, default 60 s). No retries here: callers decide (never in loops).
 */

const BASE_URL = 'https://api.dataforseo.com';
const DEFAULT_TIMEOUT_MS = 60_000;

export const DFS_OK = 20000;
export const DFS_TASK_CREATED = 20100;
export const DFS_NO_RESULTS = 40102;
export const DFS_TASK_HANDED = 40601;
export const DFS_TASK_IN_QUEUE = 40602;

export function dfsTimeoutMs(env = process.env) {
  const n = Number.parseInt(env.DATAFORSEO_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(n) && n >= 1000 ? Math.min(n, 300_000) : DEFAULT_TIMEOUT_MS;
}

export function hasDataForSeoCreds(env = process.env) {
  return Boolean(env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD);
}

function authHeader() {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) {
    throw new Error('DataForSEO credentials are not configured');
  }
  return `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;
}

/** Error carrying the DataForSEO code. accountLevel = stop the whole run (auth, balance, rate limit, server). */
export class DataForSeoError extends Error {
  constructor(message, { httpStatus = null, statusCode = null, accountLevel = false, costUsd = null } = {}) {
    super(message);
    this.name = 'DataForSeoError';
    this.httpStatus = httpStatus;
    this.statusCode = statusCode;
    this.accountLevel = accountLevel;
    this.costUsd = costUsd;
    this.code = statusCode ? `DFS_${statusCode}` : httpStatus ? `HTTP_${httpStatus}` : 'NETWORK';
  }
}

/** Auth / payment / rate-limit codes (401xx, 402xx) and server errors (≥ 50000) are account level. */
export function isAccountLevelCode(code) {
  const c = Number(code);
  return (c >= 40100 && c < 40300) || c >= 50000;
}

/** ok | pending | no_results | account | error for a DataForSEO status code. */
export function classifyDfsCode(code) {
  const c = Number(code);
  if (c === DFS_OK || c === DFS_TASK_CREATED) return 'ok';
  if (c === DFS_TASK_HANDED || c === DFS_TASK_IN_QUEUE) return 'pending';
  if (c === DFS_NO_RESULTS) return 'no_results';
  if (isAccountLevelCode(c)) return 'account';
  return 'error';
}

async function request(path, init, { timeoutMs, fetchImpl } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? dfsTimeoutMs());
  let res;
  try {
    res = await (fetchImpl || fetch)(`${BASE_URL}${path}`, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw new DataForSeoError('DataForSEO request timed out', { accountLevel: false });
    throw new DataForSeoError(`DataForSEO network error: ${err?.message || 'failed'}`, { accountLevel: true });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // Message format "DataForSEO <status>" is parsed by backlinkSnapshots.fetchBacklinkSummary.
    throw new DataForSeoError(`DataForSEO ${res.status}`, {
      httpStatus: res.status,
      accountLevel: res.status === 401 || res.status === 402 || res.status === 429 || res.status >= 500,
    });
  }
  return res.json();
}

/**
 * POST a task array to a DataForSEO endpoint path (e.g. "/v3/business_data/...").
 * Returns the parsed JSON payload (task-level codes are NOT checked: use dfsPostTask for that).
 */
export async function postDataForSeo(path, tasks, opts = {}) {
  return request(
    path,
    { method: 'POST', headers: { Authorization: authHeader(), 'Content-Type': 'application/json' }, body: JSON.stringify(tasks) },
    opts
  );
}

/**
 * GET a DataForSEO endpoint path (e.g. a task_get URL). Returns parsed JSON (task-level codes not checked).
 */
export async function getDataForSeo(path, opts = {}) {
  return request(path, { method: 'GET', headers: { Authorization: authHeader() } }, opts);
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Check one payload (top level, then the first task). Pure.
 * Returns { state: 'ok'|'pending'|'no_results', task, result, costUsd, statusCode } or throws DataForSeoError.
 */
export function parseDfsTask(json) {
  const task = json?.tasks?.[0] || null;
  const costUsd = numOrNull(task?.cost) ?? numOrNull(json?.cost);
  const top = Number(json?.status_code);
  if (top && classifyDfsCode(top) !== 'ok') {
    throw new DataForSeoError(`DataForSEO ${top}: ${json?.status_message || 'error'}`, {
      statusCode: top,
      accountLevel: isAccountLevelCode(top),
      costUsd,
    });
  }
  if (!task) throw new DataForSeoError('DataForSEO returned no task', { costUsd });
  const code = Number(task.status_code);
  const kind = classifyDfsCode(code);
  if (kind === 'pending') return { state: 'pending', task, result: null, costUsd, statusCode: code };
  if (kind === 'no_results') return { state: 'no_results', task, result: null, costUsd, statusCode: code };
  if (kind !== 'ok') {
    throw new DataForSeoError(`DataForSEO ${code}: ${task.status_message || 'task failed'}`, {
      statusCode: code,
      accountLevel: kind === 'account',
      costUsd,
    });
  }
  return { state: 'ok', task, result: task.result?.[0] ?? null, costUsd, statusCode: code };
}

/** POST one task and check both status levels. */
export async function dfsPostTask(path, task, opts = {}) {
  const json = await (opts.post || postDataForSeo)(path, [task], opts);
  return parseDfsTask(json);
}

/** GET a task_get path and check both status levels (40601 / 40602 come back as state 'pending'). */
export async function dfsGetTask(path, opts = {}) {
  const json = await (opts.get || getDataForSeo)(path, opts);
  return parseDfsTask(json);
}
