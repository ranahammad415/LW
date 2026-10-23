/**
 * Site metrics, uptime monitoring (docs/ledger/features/site-metrics.md).
 *
 * Prober (index.js, leader only, every UPTIME_INTERVAL_MIN minutes, in-process overlap guard):
 * - every eligible project (ACTIVE / SETUP, active client, https Project.wpUrl; WordPress and EmDash), at most
 *   UPTIME_MAX_SITES, 5 in parallel;
 * - `GET <site>/` with `Range: bytes=0-4095` (body capped at 4 KiB), fixed User-Agent, 10 s timeout, 2 retries with a
 *   short backoff before the probe counts as failed; follows at most 3 redirects and every hop passes the netGuard
 *   SSRF rules (https only, no private IP literal, connect-time lookup refuses private addresses);
 * - TLS: certificate expiry from the socket (getPeerCertificate) at most once an hour per site; an invalid certificate
 *   fails the probe (errorClass tls);
 * - EmDash only: `GET <site>/_agency/status` (no-store JSON {state, checkedAt, version, uptime:{db, scheduler}}); a 404 or
 *   non-JSON answer is tolerated (nothing recorded). It is recorded as target=status and never opens an incident.
 * Incidents: DOWN = 2 failed home probes in a row (opens one incident; UptimeIncident.openProjectId is unique, so at most
 * one open per project), RECOVERED = 1 ok probe (closes it). Alerts go to agency on-call + OWNERs (security routing:
 * notify in-app + email, optional Slack), one DOWN and one RECOVERED per incident (CAS on notifiedDownAt / notifiedUpAt).
 * TLS expiring in < 14 days: tls_expiring, at most once a day per site (SecurityAlertLog claim).
 * Rollup: hourly for today + yesterday, nightly final for yesterday. Retention: UptimeCheck 30 days (batches of 5000),
 * UptimeDaily 400 days, incidents kept.
 * Health v2 (factor S6) reads uptimeAvailability(rowsDaily, days) and uptimeStatus(...).
 * TODO (not in scope): an external vantage (UptimeRobot / Better Stack) can post UptimeCheck rows with source=external.
 */
import https from 'node:https';
import { prisma } from './prisma.js';
import { blockedIpLiteral, guardedLookup } from './siteAdapters/netGuard.js';
import { notify } from './notificationService.js';
import { claimAlert, onCallUserIds, ownerIds, sendSecuritySlack, escapeHtml } from './security/securityAlerts.js';

export const USER_AGENT = 'LocalWavesUptime/1.0 (+agency-os)';
export const PROBE_TIMEOUT_MS = 10_000;
export const PROBE_RETRIES = 2;
export const PROBE_BACKOFF_MS = [1000, 3000];
export const MAX_REDIRECTS = 3;
export const PROBE_CONCURRENCY = 5;
export const BODY_CAP_BYTES = 4096;
export const CERT_CHECK_EVERY_MS = 60 * 60_000;
export const TLS_WARN_DAYS = 14;
export const CHECK_RETENTION_DAYS = 30;
export const DAILY_RETENTION_DAYS = 400;
export const PURGE_BATCH = 5000;
export const DOWN_AFTER_FAILURES = 2;
const DAY_MS = 86_400_000;
const INCIDENT_NOTIFY_WINDOW_MS = 365 * DAY_MS;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const LOCAL_HOSTS = new Set(['localhost', 'localhost.localdomain']);

export function isUptimeEnabled(env = process.env) {
  return String(env.UPTIME_ENABLED ?? 'true').toLowerCase() !== 'false';
}

export function uptimeIntervalMin(env = process.env) {
  const n = Number.parseInt(env.UPTIME_INTERVAL_MIN ?? '', 10);
  return Number.isFinite(n) && n >= 1 && n <= 30 ? n : 2;
}

export function uptimeMaxSites(env = process.env) {
  const n = Number.parseInt(env.UPTIME_MAX_SITES ?? '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 2000) : 200;
}

export function uptimeCron(env = process.env) {
  return `*/${uptimeIntervalMin(env)} * * * *`;
}

/**
 * Static guard for the site home URL (no DNS here: a DNS failure must be recorded as a failed probe, not skipped).
 * https only, no credentials, no localhost, no private IP literal. Private resolution is refused at connect time.
 */
export function siteHomeUrl(project) {
  const raw = String(project?.wpUrl || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (LOCAL_HOSTS.has(u.hostname) || blockedIpLiteral(u)) return null;
    return `${u.origin}/`;
  } catch {
    return null;
  }
}

// ── Probe ───────────────────────────────────────────────────────────────────

/** Map a socket / request error to an errorClass ('blocked' = SSRF refusal, mapped by the caller). */
export function classifyError(err) {
  const code = String(err?.code || '');
  const name = String(err?.name || '');
  if (code === 'EAI_BLOCKED') return 'blocked';
  if (/^(ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT|LW_TIMEOUT)$/.test(code) || name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  if (/^(ENOTFOUND|EAI_AGAIN|EAI_NODATA|EAI_FAIL|EAI_NONAME)$/.test(code)) return 'dns';
  if (/^(CERT_|ERR_TLS|ERR_SSL|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|HOSTNAME_MISMATCH|ERR_CERT)/.test(code)) return 'tls';
  if (!code && /certificate|TLS|SSL/i.test(String(err?.message || ''))) return 'tls';
  return 'connect';
}

/**
 * One HTTPS GET with the guarded lookup, no redirect following, capped body, hard timeout. Resolves to
 * { status, location, cert, body }. `wantCert` reads the peer certificate of this connection.
 */
export function httpsGetOnce(url, { timeoutMs = PROBE_TIMEOUT_MS, wantCert = false, headers = {}, maxBytes = BODY_CAP_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(v);
    };
    const u = new URL(url);
    const req = https.request(
      u,
      { method: 'GET', agent: false, lookup: guardedLookup, headers: { 'user-agent': USER_AGENT, accept: '*/*', ...headers } },
      (res) => {
        let cert = null;
        if (wantCert) {
          try {
            const c = res.socket?.getPeerCertificate?.();
            if (c?.valid_to) cert = { validTo: new Date(c.valid_to) };
          } catch {
            cert = null;
          }
        }
        const chunks = [];
        let size = 0;
        const end = () => finish(resolve, { status: res.statusCode || 0, location: res.headers.location || null, cert, body: Buffer.concat(chunks) });
        res.on('data', (c) => {
          if (size >= maxBytes) return;
          chunks.push(c.subarray(0, maxBytes - size));
          size += c.length;
          if (size >= maxBytes) {
            end();
            res.destroy();
          }
        });
        res.on('end', end);
        res.on('error', (e) => finish(reject, e));
      }
    );
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('Probe timed out'), { code: 'LW_TIMEOUT' })), timeoutMs);
    req.on('error', (e) => finish(reject, e));
    req.end();
  });
}

function classifyStatus(status) {
  if (status >= 200 && status < 300) return null;
  if (status === 416) return null; // Range not satisfiable: the server answered, the site is up
  if (status >= 500) return 'http_5xx';
  if (status >= 400) return 'http_4xx';
  return 'redirect';
}

/**
 * One probe (no retry): follows ≤ MAX_REDIRECTS redirects, every hop through the SSRF rules.
 * @returns {{ ok, httpStatus, ms, errorClass, tlsExpiresAt, hops: string[] }}
 */
export async function probeOnce(url, { request = httpsGetOnce, wantCert = false, timeoutMs = PROBE_TIMEOUT_MS, clock = Date.now } = {}) {
  const started = clock();
  const hops = [];
  let current = url;
  let tlsExpiresAt = null;
  const out = (ok, httpStatus, errorClass) => ({ ok, httpStatus, ms: Math.max(0, Math.round(clock() - started)), errorClass, tlsExpiresAt, hops });
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let u;
    try {
      u = new URL(current);
    } catch {
      return out(false, null, 'redirect');
    }
    if (u.protocol !== 'https:' || u.username || u.password || LOCAL_HOSTS.has(u.hostname) || blockedIpLiteral(u)) {
      return out(false, null, hop > 0 ? 'redirect' : 'connect');
    }
    let r;
    try {
      r = await request(u.toString(), { timeoutMs, wantCert: wantCert && hop === 0, headers: { range: `bytes=0-${BODY_CAP_BYTES - 1}` } });
    } catch (err) {
      const cls = classifyError(err);
      return out(false, null, cls === 'blocked' ? (hop > 0 ? 'redirect' : 'dns') : cls);
    }
    if (hop === 0 && r.cert?.validTo && !Number.isNaN(r.cert.validTo.getTime())) tlsExpiresAt = r.cert.validTo;
    if (REDIRECT_STATUSES.has(r.status) && r.location) {
      if (hop === MAX_REDIRECTS) return out(false, r.status, 'redirect');
      try {
        current = new URL(r.location, u).toString();
      } catch {
        return out(false, r.status, 'redirect');
      }
      hops.push(current);
      continue;
    }
    const cls = classifyStatus(r.status);
    return out(!cls, r.status, cls);
  }
  return out(false, null, 'redirect');
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** probeOnce with PROBE_RETRIES retries and a short backoff; only the final attempt is reported. */
export async function probeWithRetry(url, { retries = PROBE_RETRIES, backoffMs = PROBE_BACKOFF_MS, sleep = realSleep, ...opts } = {}) {
  let r;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    r = await probeOnce(url, { ...opts, wantCert: opts.wantCert && attempt === 0 });
    if (r.ok) return { ...r, attempts: attempt + 1 };
    if (attempt < retries) await sleep(backoffMs[Math.min(attempt, backoffMs.length - 1)]);
  }
  return { ...r, attempts: retries + 1 };
}

const BAD_MARKERS = new Set(['down', 'error', 'fail', 'failed', 'degraded', 'critical']);
/** errorClass of an ok status row whose scheduler is stale: a staff warning, never an incident (O-R3-3). */
export const SCHEDULER_STALE = 'sched_stale';
/** errorClass of a probe taken during a site restore's maintenance window (v1.9.1 §41.5): never counts towards DOWN. */
export const MAINTENANCE = 'maintenance';
/** errorClass when the site says its restore failed (maintenance reason "restore-failed": the live database may be
 *  missing; the site then serves a 503 page everywhere until someone intervenes). A real incident, opened at once. */
export const RESTORE_FAILED = 'restore_failed';
/** A JSON "maintenance" older than this (maintenance.since) is no longer trusted as a planned window. */
export const MAINTENANCE_MAX_MS = 30 * 60_000;

/**
 * EmDash `/_agency/status`. Returns null when the endpoint is missing (404 / non-JSON / redirect), else
 * { ok, httpStatus, ms, errorClass }.
 * Reachable = HTTP 200 and `uptime.db === 'ok'` (else errorClass marker); a failing scheduler (down / error) is a marker
 * too. `uptime.scheduler === 'stale'` stays ok with errorClass `sched_stale` (a warning on the staff panel only).
 * `state` is the site's SECURITY roll-up (a failing SPF or backup check makes it `fail`), not an uptime signal: it is
 * never read here (release-3 e2e O-R3-3).
 */
export async function probeStatusEndpoint(origin, { request = httpsGetOnce, clock = Date.now } = {}) {
  const url = `${origin.replace(/\/$/, '')}/_agency/status`;
  const started = clock();
  let r;
  try {
    r = await request(url, { timeoutMs: PROBE_TIMEOUT_MS, headers: { accept: 'application/json', 'cache-control': 'no-store' }, maxBytes: 16 * 1024 });
  } catch (err) {
    const cls = classifyError(err);
    return { ok: false, httpStatus: null, ms: Math.round(clock() - started), errorClass: cls === 'blocked' ? 'dns' : cls };
  }
  const ms = Math.round(clock() - started);
  if (r.status === 404 || REDIRECT_STATUSES.has(r.status)) return null;
  if (r.status >= 500) return { ok: false, httpStatus: r.status, ms, errorClass: 'http_5xx' };
  if (r.status >= 400) return null;
  let json;
  try {
    json = JSON.parse(r.body.toString('utf8'));
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object') return null;
  const lc = (v) => String(v ?? '').toLowerCase();
  // v1.9.1 §41.5: a restore is swapping the database (public site 503 + Retry-After 120 for 1–3 minutes). Planned:
  // recorded as `maintenance`, never an incident or a page.
  if (lc(json.state) === 'maintenance') {
    const reason = lc(json.maintenance?.reason);
    if (reason === 'restore-failed') return { ok: false, httpStatus: r.status, ms, errorClass: RESTORE_FAILED };
    const since = Date.parse(json.maintenance?.since);
    // a swap takes 1–3 minutes: a "maintenance" that started more than 30 minutes ago is a stuck site, not a window
    if (Number.isFinite(since) && clock() - since > MAINTENANCE_MAX_MS) return { ok: false, httpStatus: r.status, ms, errorClass: 'marker' };
    return { ok: false, httpStatus: r.status, ms, errorClass: MAINTENANCE, maintenance: true };
  }
  const scheduler = lc(json.uptime?.scheduler);
  const marker = r.status !== 200 || lc(json.uptime?.db) !== 'ok' || json.uptime?.scheduler === false || BAD_MARKERS.has(scheduler);
  if (marker) return { ok: false, httpStatus: r.status, ms, errorClass: 'marker' };
  return { ok: true, httpStatus: r.status, ms, errorClass: scheduler === 'stale' ? SCHEDULER_STALE : null };
}

// ── Incidents + alerts ─────────────────────────────────────────────────────

const REASON_TEXT = {
  timeout: `no answer within ${PROBE_TIMEOUT_MS / 1000} s`,
  dns: 'the domain name does not resolve',
  tls: 'https certificate problem',
  http_5xx: 'server error',
  http_4xx: 'the home page returns an error',
  connect: 'connection failed',
  redirect: 'too many or unsafe redirects',
  marker: 'the site reports a problem',
  maintenance: 'planned maintenance (site restore)',
  restore_failed: 'the site restore failed (the site reports restore-failed)',
};

/** Short OS-written text for staff (never a raw socket message, so no IPs or headers). */
export function lastErrorText(errorClass, httpStatus) {
  const base = REASON_TEXT[errorClass] || 'probe failed';
  return (httpStatus ? `${base} (HTTP ${httpStatus})` : base).slice(0, 120);
}

/** "about 4 minutes", "1 hour 20 minutes", "2 days 3 hours". */
export function durationText(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return 'less than a minute';
  const m = Math.round(s / 60);
  if (m < 60) return `about ${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'}${rm ? ` ${rm} minute${rm === 1 ? '' : 's'}` : ''}`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return `${d} day${d === 1 ? '' : 's'}${rh ? ` ${rh} hour${rh === 1 ? '' : 's'}` : ''}`;
}

const projectUrl = (projectId) => `/portal/admin/projects/${projectId}?tab=site-performance`;

async function alertRecipients() {
  const [oncall, owners] = await Promise.all([onCallUserIds(), ownerIds()]);
  return [...new Set([...oncall, ...owners])];
}

function isUniqueViolation(err) {
  return err && (err.code === 'P2002' || /Unique constraint/i.test(String(err.message || '')));
}

/** One DOWN per incident: CAS on notifiedDownAt. */
export async function sendDownAlert(project, incident, { now = new Date(), env = process.env, log } = {}) {
  const claim = await prisma.uptimeIncident.updateMany({ where: { id: incident.id, notifiedDownAt: null }, data: { notifiedDownAt: now } });
  if (!claim.count) return false;
  const name = project.name || 'a website';
  await notify({
    slug: 'site_down',
    recipientIds: await alertRecipients(),
    variables: { projectName: escapeHtml(name), reason: escapeHtml(incident.lastError || REASON_TEXT[incident.cause] || 'probe failed'), since: new Date(incident.openedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' },
    actionUrl: projectUrl(project.id),
    metadata: { projectId: project.id, kind: 'uptime', incidentId: incident.id },
  });
  await sendSecuritySlack(`:red_circle: Website down: ${name} (${incident.lastError || incident.cause})`, { env, log });
  return true;
}

/** One RECOVERED per incident (only when its DOWN went out): CAS on notifiedUpAt. */
export async function sendRecoveredAlert(project, incident, { now = new Date(), env = process.env, log } = {}) {
  if (!incident.notifiedDownAt) return false;
  const claim = await prisma.uptimeIncident.updateMany({ where: { id: incident.id, notifiedUpAt: null }, data: { notifiedUpAt: now } });
  if (!claim.count) return false;
  const name = project.name || 'a website';
  const duration = durationText(incident.durationSec);
  await notify({
    slug: 'site_recovered',
    recipientIds: await alertRecipients(),
    variables: { projectName: escapeHtml(name), duration },
    actionUrl: projectUrl(project.id),
    metadata: { projectId: project.id, kind: 'uptime', incidentId: incident.id },
  });
  await sendSecuritySlack(`:large_green_circle: Website back up: ${name} (down ${duration})`, { env, log });
  return true;
}

/** TLS expiring in < TLS_WARN_DAYS: at most once a day per site. */
export async function maybeAlertTls(project, tlsExpiresAt, { now = new Date(), env = process.env, log } = {}) {
  if (!tlsExpiresAt) return false;
  const daysLeft = Math.floor((new Date(tlsExpiresAt).getTime() - now.getTime()) / DAY_MS);
  if (daysLeft >= TLS_WARN_DAYS) return false;
  if (!(await claimAlert(project.id, 'uptime:tls_expiring', { now }))) return false;
  const name = project.name || 'a website';
  await notify({
    slug: 'tls_expiring',
    recipientIds: await alertRecipients(),
    variables: { projectName: escapeHtml(name), expiresAt: new Date(tlsExpiresAt).toISOString().slice(0, 10), daysLeft: String(Math.max(0, daysLeft)) },
    actionUrl: projectUrl(project.id),
    metadata: { projectId: project.id, kind: 'uptime_tls' },
  });
  await sendSecuritySlack(`:warning: Certificate of ${name} expires in ${Math.max(0, daysLeft)} days`, { env, log });
  return true;
}

/**
 * Incident state machine after a home probe was stored. Returns 'up' | 'recovered' | 'failing' | 'down' | 'still_down'.
 */
export async function applyIncidentLogic(project, result, { now = new Date(), env, log, immediate = false } = {}) {
  const open = await prisma.uptimeIncident.findUnique({ where: { openProjectId: project.id } });
  if (result.ok) {
    if (!open) return 'up';
    const durationSec = Math.max(0, Math.round((now.getTime() - new Date(open.openedAt).getTime()) / 1000));
    const closed = await prisma.uptimeIncident.updateMany({ where: { id: open.id, closedAt: null }, data: { closedAt: now, durationSec, openProjectId: null } });
    if (closed.count) await sendRecoveredAlert(project, { ...open, durationSec }, { now, env, log });
    return 'recovered';
  }
  const lastError = lastErrorText(result.errorClass, result.httpStatus);
  if (open) {
    await prisma.uptimeIncident.update({ where: { id: open.id }, data: { lastError } });
    return 'still_down';
  }
  // immediate (a failed site restore, v1.9.1): DOWN on this one probe, no second failure needed.
  const recent = immediate
    ? [{ ok: false, at: now, errorClass: result.errorClass }]
    : await prisma.uptimeCheck.findMany({
        where: { projectId: project.id, target: 'home', source: 'os' },
        orderBy: { at: 'desc' },
        take: DOWN_AFTER_FAILURES,
        select: { ok: true, at: true, errorClass: true },
      });
  // A probe inside a restore maintenance window never counts towards DOWN (v1.9.1 §41.5).
  if (!immediate && (recent.length < DOWN_AFTER_FAILURES || recent.some((r) => r.ok || r.errorClass === MAINTENANCE))) return 'failing';
  let incident;
  try {
    incident = await prisma.uptimeIncident.create({
      data: { projectId: project.id, openedAt: recent[recent.length - 1].at, cause: result.errorClass || 'connect', lastError, openProjectId: project.id },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return 'still_down';
    throw err;
  }
  await sendDownAlert(project, incident, { now, env, log });
  return 'down';
}

/**
 * True when the latest maintenance-type answer of /_agency/status (last 2 h) said reason "restore-failed" and the
 * endpoint has not answered ok since (the site then serves a minimal 503 page everywhere, v1.9.1).
 */
export async function lastStatusSaidRestoreFailed(projectId, now = new Date()) {
  return (await lastMaintenanceStatus(projectId, now)) === RESTORE_FAILED;
}

/** A status probe that said `maintenance` this recently opens the window for the restart that follows (O-C191-1). */
export const STATUS_MAINTENANCE_CARRY_MS = 5 * 60_000;

/**
 * The latest maintenance-type answer of /_agency/status (last 2 h) when nothing ok came after it:
 *   RESTORE_FAILED: the site said reason "restore-failed" → a real incident;
 *   MAINTENANCE: it said "maintenance" ≤ 5 min ago → the restart that follows a swap is maintenance too. This covers a
 *     rollback, which (unlike a restore) sends no event before its swap (e2e O-C191-1), and any restore whose
 *     restore_started the OS has not received;
 *   null otherwise.
 */
export async function lastMaintenanceStatus(projectId, now = new Date()) {
  const since = new Date(now.getTime() - 2 * 60 * 60_000);
  const last = await prisma.uptimeCheck.findFirst({
    where: { projectId, target: 'status', at: { gte: since }, errorClass: { in: [MAINTENANCE, RESTORE_FAILED] } },
    orderBy: { at: 'desc' },
    select: { at: true, errorClass: true },
  });
  if (!last) return null;
  if (last.errorClass === MAINTENANCE && now.getTime() - new Date(last.at).getTime() > STATUS_MAINTENANCE_CARRY_MS) return null;
  const okAfter = await prisma.uptimeCheck.findFirst({ where: { projectId, target: 'status', ok: true, at: { gt: last.at } }, select: { id: true } });
  return okAfter ? null : last.errorClass;
}

// ── Prober job ──────────────────────────────────────────────────────────────

const lastCertCheck = new Map();

/** Probe one project: home (+ TLS once an hour), EmDash status endpoint, incident logic, TLS alert. */
export async function probeProject(project, { now = new Date(), request, sleep, env = process.env, log, clock } = {}) {
  const url = siteHomeUrl(project);
  if (!url) return { skipped: 'NO_URL' };
  const wantCert = now.getTime() - (lastCertCheck.get(project.id) || 0) >= CERT_CHECK_EVERY_MS;
  const r = await probeWithRetry(url, { request, sleep, wantCert, clock });
  if (wantCert && (r.tlsExpiresAt || r.errorClass === 'tls' || r.ok)) lastCertCheck.set(project.id, now.getTime());
  // EmDash: the status endpoint first, so a failed home probe during a restore swap is recorded as maintenance
  // (v1.9.1 §41.5: `/_agency/status` says state "maintenance"; or the OS saw a backup.restore_started that has not
  // finished, or one that finished minutes ago, while the process restarts). Never paged.
  // The window covers any failure of the home probe (connection errors, 502 / 503, timeouts: the 10–40 s restart has
  // no HTTP answer at all), not only a JSON "maintenance". It ends 30 min after restore_started without a completion
  // (a 503 page on /_agency/status then opens a real incident). A site that last said reason "restore-failed" is a
  // real incident at once.
  let s = null;
  let maintenance = false;
  let restoreFailed = false;
  if (project.cmsType === 'EMDASH') {
    s = await probeStatusEndpoint(url, { request, clock });
    if (!r.ok) {
      if (s?.errorClass === RESTORE_FAILED) restoreFailed = true;
      else if (s?.maintenance) maintenance = true;
      else {
        const last = await lastMaintenanceStatus(project.id, now);
        if (last === RESTORE_FAILED) restoreFailed = true;
        else if (last === MAINTENANCE) maintenance = true;
      }
      if (!restoreFailed && !maintenance) {
        const { restoreMaintenanceWindow } = await import('./security/restoreStore.js');
        maintenance = !!(await restoreMaintenanceWindow(project.id, now).catch(() => null));
      }
    }
  }
  const home = maintenance ? { ...r, errorClass: MAINTENANCE } : restoreFailed ? { ...r, errorClass: RESTORE_FAILED } : r;
  await prisma.uptimeCheck.create({
    data: { projectId: project.id, at: now, target: 'home', source: 'os', ok: home.ok, httpStatus: home.httpStatus, ms: home.ms, errorClass: home.errorClass, tlsExpiresAt: home.tlsExpiresAt },
  });
  if (s) {
    await prisma.uptimeCheck.create({ data: { projectId: project.id, at: now, target: 'status', source: 'os', ok: s.ok, httpStatus: s.httpStatus, ms: s.ms, errorClass: s.errorClass } });
  }
  if (maintenance) {
    log?.info?.({ projectId: project.id, httpStatus: r.httpStatus }, 'Uptime: site in a restore maintenance window; no incident');
    return { ok: false, errorClass: MAINTENANCE, incident: 'maintenance' };
  }
  const incident = await applyIncidentLogic(project, home, { now, env, log, immediate: restoreFailed });
  if (restoreFailed) log?.warn?.({ projectId: project.id, httpStatus: r.httpStatus }, 'Uptime: the site reports a failed restore; incident opened');
  if (r.tlsExpiresAt) await maybeAlertTls(project, r.tlsExpiresAt, { now, env, log });
  return { ok: r.ok, errorClass: r.errorClass, incident };
}

async function eligibleProjects(cap) {
  return prisma.project.findMany({
    where: { status: { in: ['ACTIVE', 'SETUP'] }, wpUrl: { not: null }, client: { isActive: true } },
    select: { id: true, name: true, wpUrl: true, cmsType: true },
    orderBy: { id: 'asc' },
    take: cap,
  });
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

let running = false;

/** One prober tick. Skips (does not queue) while the previous tick is still running. */
export async function runUptimeProbes({ log, now, request, sleep, env = process.env } = {}) {
  if (!isUptimeEnabled(env)) return { skipped: 'disabled' };
  if (running) return { skipped: 'overlap' };
  running = true;
  try {
    const projects = await eligibleProjects(uptimeMaxSites(env));
    const at = now || new Date();
    const results = await mapPool(projects, PROBE_CONCURRENCY, async (p) => {
      try {
        return await probeProject(p, { now: at, request, sleep, env, log });
      } catch (err) {
        log?.warn?.({ projectId: p.id, message: err?.message }, 'Uptime probe failed');
        return { error: true };
      }
    });
    return {
      sites: projects.length,
      up: results.filter((r) => r?.ok).length,
      failing: results.filter((r) => r && r.ok === false).length,
      opened: results.filter((r) => r?.incident === 'down').length,
      recovered: results.filter((r) => r?.incident === 'recovered').length,
      errors: results.filter((r) => r?.error).length,
    };
  } finally {
    running = false;
  }
}

/** Test hook: reset the in-memory overlap flag and certificate clock. */
export function _resetUptimeState() {
  running = false;
  lastCertCheck.clear();
}

// ── Rollup + retention ─────────────────────────────────────────────────────

export function utcDayStart(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Nearest-rank percentile of numbers (null when empty). */
export function percentile(values, p) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const rank = Math.ceil((p / 100) * v.length);
  return v[Math.min(v.length, Math.max(1, rank)) - 1];
}

/**
 * Pure daily rollup of one project's home checks + incidents for [dayStart, dayStart + 1 day).
 * availabilityPct = ok / checks × 100 (3 decimals); avg / p95 over ok probes; downtime = incident overlap with the day
 * (an open incident runs until `now`). Probes in a restore maintenance window (errorClass `maintenance`, v1.9.1 §41.5)
 * are planned downtime: left out of the availability.
 */
export function computeDailyRollup(allChecks, incidents, dayStart, now = new Date()) {
  const checks = allChecks.filter((c) => c.errorClass !== MAINTENANCE);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  const n = checks.length;
  const okChecks = checks.filter((c) => c.ok).length;
  const okMs = checks.filter((c) => c.ok && typeof c.ms === 'number').map((c) => c.ms);
  const avgMs = okMs.length ? Math.round(okMs.reduce((a, b) => a + b, 0) / okMs.length) : null;
  const cap = Math.min(dayEnd.getTime(), now.getTime());
  let downtimeMs = 0;
  let opened = 0;
  for (const inc of incidents) {
    const o = new Date(inc.openedAt).getTime();
    const c = inc.closedAt ? new Date(inc.closedAt).getTime() : now.getTime();
    if (o >= dayStart.getTime() && o < dayEnd.getTime()) opened += 1;
    const from = Math.max(o, dayStart.getTime());
    const to = Math.min(c, cap);
    if (to > from) downtimeMs += to - from;
  }
  return {
    checks: n,
    okChecks,
    availabilityPct: n ? Number(((okChecks / n) * 100).toFixed(3)) : null,
    avgMs,
    p95Ms: percentile(okMs, 95),
    incidents: opened,
    downtimeSec: Math.round(downtimeMs / 1000),
  };
}

/** Recompute UptimeDaily for the given UTC days (default today + yesterday). */
export async function rollupUptime({ now = new Date(), days } = {}) {
  const today = utcDayStart(now);
  const list = days || [today, new Date(today.getTime() - DAY_MS)];
  let rows = 0;
  for (const dayStart of list) {
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    const checks = await prisma.uptimeCheck.findMany({
      where: { target: 'home', at: { gte: dayStart, lt: dayEnd } },
      select: { projectId: true, ok: true, ms: true, errorClass: true },
    });
    const incidents = await prisma.uptimeIncident.findMany({
      where: { openedAt: { lt: dayEnd }, OR: [{ closedAt: null }, { closedAt: { gte: dayStart } }] },
      select: { projectId: true, openedAt: true, closedAt: true },
    });
    const byProject = new Map();
    for (const c of checks) {
      if (!byProject.has(c.projectId)) byProject.set(c.projectId, { checks: [], incidents: [] });
      byProject.get(c.projectId).checks.push(c);
    }
    for (const i of incidents) {
      if (!byProject.has(i.projectId)) byProject.set(i.projectId, { checks: [], incidents: [] });
      byProject.get(i.projectId).incidents.push(i);
    }
    for (const [projectId, g] of byProject) {
      const data = computeDailyRollup(g.checks, g.incidents, dayStart, now);
      await prisma.uptimeDaily.upsert({
        where: { projectId_date: { projectId, date: dayStart } },
        create: { projectId, date: dayStart, ...data },
        update: data,
      });
      rows += 1;
    }
  }
  return { rows };
}

/** Delete raw checks older than 30 days in batches of ≤ PURGE_BATCH (bounded per run), daily rows older than 400 days. */
export async function purgeUptime({ now = new Date(), batch = PURGE_BATCH, maxBatches = 50 } = {}) {
  const cutoff = new Date(now.getTime() - CHECK_RETENTION_DAYS * DAY_MS);
  let checks = 0;
  for (let i = 0; i < maxBatches; i += 1) {
    const ids = await prisma.uptimeCheck.findMany({ where: { at: { lt: cutoff } }, select: { id: true }, take: Math.min(batch, PURGE_BATCH), orderBy: { at: 'asc' } });
    if (!ids.length) break;
    const res = await prisma.uptimeCheck.deleteMany({ where: { id: { in: ids.map((r) => r.id) } } });
    checks += res?.count ?? ids.length;
    if (ids.length < Math.min(batch, PURGE_BATCH)) break;
  }
  const dailyCutoff = new Date(utcDayStart(now).getTime() - DAILY_RETENTION_DAYS * DAY_MS);
  const daily = await prisma.uptimeDaily.deleteMany({ where: { date: { lt: dailyCutoff } } });
  return { checks, daily: daily?.count ?? 0 };
}

// ── Health v2 helpers (pure) ───────────────────────────────────────────────

/** Availability % over the last `days` UTC days of UptimeDaily rows (check-weighted; null without checks). */
export function uptimeAvailability(rowsDaily, days, now = new Date()) {
  const from = utcDayStart(now).getTime() - (days - 1) * DAY_MS;
  let checks = 0;
  let ok = 0;
  for (const r of rowsDaily || []) {
    if (new Date(r.date).getTime() < from) continue;
    checks += r.checks || 0;
    ok += r.okChecks || 0;
  }
  return checks ? Number(((ok / checks) * 100).toFixed(3)) : null;
}

/**
 * Current state + rating for Health v2 (S6) and the views. state: down while an incident is open, unknown when the
 * last probe is older than 3 intervals (or none), else up. rating from availability30: ≥ 99.9 good, ≥ 99 needs
 * improvement, below poor.
 */
export function uptimeStatus({ openIncident = null, lastCheckAt = null, availability30 = null, now = new Date(), staleMs = 3 * uptimeIntervalMin() * 60_000 + 60_000 } = {}) {
  let state = 'up';
  if (openIncident) state = 'down';
  else if (!lastCheckAt || now.getTime() - new Date(lastCheckAt).getTime() > staleMs) state = 'unknown';
  let rating = 'unknown';
  if (typeof availability30 === 'number') rating = availability30 >= 99.9 ? 'good' : availability30 >= 99 ? 'needs_improvement' : 'poor';
  return { state, rating };
}

// ── Views ───────────────────────────────────────────────────────────────────

/** Staff view of one project. */
export async function staffUptimeView(project, { now = new Date(), env = process.env } = {}) {
  const since24 = new Date(now.getTime() - DAY_MS);
  const since90 = new Date(utcDayStart(now).getTime() - 89 * DAY_MS);
  const since30 = new Date(utcDayStart(now).getTime() - 29 * DAY_MS);
  const [checks24, daily, incidents, open, lastTls, lastStatus, first30, count30] = await Promise.all([
    prisma.uptimeCheck.findMany({ where: { projectId: project.id, target: 'home', at: { gte: since24 } }, select: { at: true, ok: true, ms: true, httpStatus: true, errorClass: true }, orderBy: { at: 'asc' } }),
    prisma.uptimeDaily.findMany({ where: { projectId: project.id, date: { gte: since90 } }, select: { date: true, checks: true, okChecks: true, availabilityPct: true, avgMs: true, p95Ms: true, incidents: true, downtimeSec: true }, orderBy: { date: 'asc' } }),
    prisma.uptimeIncident.findMany({ where: { projectId: project.id, OR: [{ openedAt: { gte: since90 } }, { closedAt: null }] }, select: { id: true, openedAt: true, closedAt: true, cause: true, lastError: true, durationSec: true }, orderBy: { openedAt: 'desc' }, take: 50 }),
    prisma.uptimeIncident.findUnique({ where: { openProjectId: project.id }, select: { id: true, openedAt: true, cause: true, lastError: true } }),
    prisma.uptimeCheck.findFirst({ where: { projectId: project.id, target: 'home', tlsExpiresAt: { not: null } }, select: { tlsExpiresAt: true, at: true }, orderBy: { at: 'desc' } }),
    prisma.uptimeCheck.findFirst({ where: { projectId: project.id, target: 'status' }, select: { ok: true, at: true, errorClass: true, httpStatus: true }, orderBy: { at: 'desc' } }),
    prisma.uptimeCheck.findFirst({ where: { projectId: project.id, target: 'home', at: { gte: since30 } }, select: { at: true }, orderBy: { at: 'asc' } }),
    prisma.uptimeCheck.count({ where: { projectId: project.id, target: 'home', at: { gte: since30 } } }),
  ]);
  const last = checks24[checks24.length - 1] || null;
  const okCount = checks24.filter((c) => c.ok).length;
  // O-R3B-6: no percentage at all (24 h … 90 days) while monitoring is 'starting'; the raw series and daily rows stay.
  const monitoring = uptimeMonitoringState({ checks: count30, firstAt: first30?.at, now });
  const pct = (v) => (monitoring === 'active' ? v : null);
  const availability30 = pct(uptimeAvailability(daily, 30, now));
  const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
  return {
    enabled: isUptimeEnabled(env),
    monitored: Boolean(siteHomeUrl(project)),
    ...uptimeStatus({ openIncident: open, lastCheckAt: last?.at, availability30, now }),
    monitoring,
    openIncident: open,
    lastCheck: last,
    availability: {
      h24: pct(checks24.length ? Number(((okCount / checks24.length) * 100).toFixed(3)) : null),
      d7: pct(uptimeAvailability(daily, 7, now)),
      d30: availability30,
      d90: pct(uptimeAvailability(daily, 90, now)),
    },
    series24h: checks24.map((c) => ({ at: c.at, ok: c.ok, ms: c.ms })),
    daily: daily.map((d) => ({ ...d, date: dayKey(d.date) })),
    incidents,
    tls: lastTls?.tlsExpiresAt
      ? { expiresAt: lastTls.tlsExpiresAt, daysLeft: Math.floor((new Date(lastTls.tlsExpiresAt).getTime() - now.getTime()) / DAY_MS), checkedAt: lastTls.at }
      : null,
    // warning (O-R3-3): 'scheduler_stale' when the last status row was ok with a stale scheduler. Never an incident.
    statusEndpoint: lastStatus ? { ...lastStatus, warning: lastStatus.ok && lastStatus.errorClass === SCHEDULER_STALE ? 'scheduler_stale' : null } : null,
  };
}

/** Fleet: every monitored project (PMs: only their own), current state, 30-day %, last incident, mean daily p95. */
export async function uptimeFleetView(user, { now = new Date() } = {}) {
  const where = { status: { in: ['ACTIVE', 'SETUP'] }, wpUrl: { not: null } };
  if (user.role !== 'OWNER') {
    where.OR = [{ leadPmId: user.id }, { client: { leadPmId: user.id } }, { client: { secondaryPmId: user.id } }];
  }
  const projects = await prisma.project.findMany({ where, select: { id: true, name: true, wpUrl: true, client: { select: { agencyName: true } } }, orderBy: { name: 'asc' }, take: 1000 });
  const ids = projects.map((p) => p.id);
  if (!ids.length) return [];
  const since30 = new Date(utcDayStart(now).getTime() - 29 * DAY_MS);
  const [daily, incidents, lastChecks, recent30] = await Promise.all([
    prisma.uptimeDaily.findMany({ where: { projectId: { in: ids }, date: { gte: since30 } }, select: { projectId: true, date: true, checks: true, okChecks: true, p95Ms: true } }),
    prisma.uptimeIncident.findMany({ where: { projectId: { in: ids }, openedAt: { gte: new Date(now.getTime() - 90 * DAY_MS) } }, select: { projectId: true, openedAt: true, closedAt: true, durationSec: true, cause: true }, orderBy: { openedAt: 'desc' } }),
    prisma.uptimeCheck.groupBy({ by: ['projectId'], where: { projectId: { in: ids }, target: 'home' }, _max: { at: true } }),
    prisma.uptimeCheck.groupBy({ by: ['projectId'], where: { projectId: { in: ids }, target: 'home', at: { gte: since30 } }, _min: { at: true }, _count: { _all: true } }),
  ]);
  const recentBy = new Map(recent30.map((g) => [g.projectId, { firstAt: g._min?.at || null, checks: Number(g._count?._all) || 0 }]));
  const openSet = new Set((await prisma.uptimeIncident.findMany({ where: { projectId: { in: ids }, closedAt: null }, select: { projectId: true } })).map((r) => r.projectId));
  const lastAt = new Map(lastChecks.map((g) => [g.projectId, g._max?.at || null]));
  return projects.map((p) => {
    const rows = daily.filter((d) => d.projectId === p.id);
    // O-R3B-6: no figure while monitoring is 'starting' (too few probes, or under 24 h since the first one)
    const monitoring = uptimeMonitoringState({ ...(recentBy.get(p.id) || {}), now });
    const availability30 = monitoring === 'active' ? uptimeAvailability(rows, 30, now) : null;
    const p95s = rows.map((r) => r.p95Ms).filter((v) => typeof v === 'number');
    const lastIncident = incidents.find((i) => i.projectId === p.id) || null;
    return {
      projectId: p.id,
      name: p.name,
      clientName: p.client?.agencyName || null,
      ...uptimeStatus({ openIncident: openSet.has(p.id), lastCheckAt: lastAt.get(p.id), availability30, now }),
      availability30,
      monitoring,
      p95Ms: p95s.length ? Math.round(p95s.reduce((a, b) => a + b, 0) / p95s.length) : null,
      lastIncident: lastIncident ? { openedAt: lastIncident.openedAt, closedAt: lastIncident.closedAt, durationSec: lastIncident.durationSec, cause: lastIncident.cause } : null,
    };
  });
}

/**
 * Client view (allow-list): 30-day availability, up / down / unknown and the last 90 days of incidents as
 * { startedAt, durationText }. No cause, error text, status code, IP, header or URL.
 */
/** Share of the expected home probes that exist (O-R3-4): below this the client sees no percentage. */
export const CLIENT_MIN_PROBE_COVERAGE = 0.6;

/**
 * Probe coverage of the 30-day window: stored home probes / probes expected since monitoring started (the first
 * probe in the window) at one per UPTIME_INTERVAL_MIN. 0..1, or 0 without any probe.
 */
export function uptimeCoverage({ checks = 0, firstAt = null, now = new Date(), intervalMin = uptimeIntervalMin() } = {}) {
  if (!firstAt || !checks) return 0;
  const since30 = utcDayStart(now).getTime() - 29 * DAY_MS;
  const start = Math.max(new Date(firstAt).getTime(), since30);
  const expected = Math.floor(Math.max(0, now.getTime() - start) / (intervalMin * 60_000)) + 1;
  return Math.min(1, checks / expected);
}

/** Minimum time since the first probe before any percentage is shown (O-R3B-6: one probe is not "100 % (30 days)"). */
export const MIN_MONITORING_MS = 24 * 3600_000;

/**
 * 'active' only with BOTH at least CLIENT_MIN_PROBE_COVERAGE of the expected probes since the first probe AND at least
 * 24 h since that first probe (O-R3B-6); otherwise 'starting' (no percentage, client and staff).
 */
export function uptimeMonitoringState({ checks = 0, firstAt = null, now = new Date(), intervalMin = uptimeIntervalMin() } = {}) {
  if (!firstAt || !checks) return 'starting';
  if (now.getTime() - new Date(firstAt).getTime() < MIN_MONITORING_MS) return 'starting';
  return uptimeCoverage({ checks, firstAt, now, intervalMin }) >= CLIENT_MIN_PROBE_COVERAGE ? 'active' : 'starting';
}

export async function clientUptimeView(project, { now = new Date() } = {}) {
  const since90 = new Date(utcDayStart(now).getTime() - 89 * DAY_MS);
  const since30 = new Date(utcDayStart(now).getTime() - 29 * DAY_MS);
  const [daily, incidents, open, last, first, recent] = await Promise.all([
    prisma.uptimeDaily.findMany({ where: { projectId: project.id, date: { gte: since90 } }, select: { date: true, checks: true, okChecks: true } }),
    prisma.uptimeIncident.findMany({ where: { projectId: project.id, openedAt: { gte: since90 } }, select: { openedAt: true, closedAt: true, durationSec: true }, orderBy: { openedAt: 'desc' }, take: 10 }),
    prisma.uptimeIncident.findUnique({ where: { openProjectId: project.id }, select: { openedAt: true } }),
    prisma.uptimeCheck.findFirst({ where: { projectId: project.id, target: 'home' }, select: { at: true }, orderBy: { at: 'desc' } }),
    prisma.uptimeCheck.findFirst({ where: { projectId: project.id, target: 'home', at: { gte: since30 } }, select: { at: true }, orderBy: { at: 'asc' } }),
    prisma.uptimeCheck.count({ where: { projectId: project.id, target: 'home', at: { gte: since30 } } }),
  ]);
  const availability30 = uptimeAvailability(daily, 30, now);
  if (availability30 == null && !last) return { available: false };
  const { state } = uptimeStatus({ openIncident: open, lastCheckAt: last?.at, availability30, now });
  // O-R3-4 / O-R3B-6: with sparse probes (C: a few probes, then the prober went quiet) or under 24 h of monitoring (a
  // single probe) a percentage is misleading: the client gets no figure and the "starting to monitor" sentence; never both.
  const enough = availability30 != null && uptimeMonitoringState({ checks: recent, firstAt: first?.at, now }) === 'active';
  return {
    available: true,
    availability30: enough ? Number(availability30.toFixed(2)) : null,
    monitoring: enough ? 'active' : 'starting',
    state,
    incidents: incidents.map((i) => ({
      startedAt: new Date(i.openedAt).toISOString(),
      durationText: i.closedAt ? durationText(i.durationSec ?? (new Date(i.closedAt).getTime() - new Date(i.openedAt).getTime()) / 1000) : 'ongoing',
    })),
  };
}
