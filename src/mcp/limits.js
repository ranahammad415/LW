/**
 * Per-grant MCP rate limits (features/mcp-server.md §Audit, limits, redaction).
 * - MCP_RATE_PER_MIN: in-memory sliding window per PM2 instance (same caveat as every existing limiter).
 * - MCP_RATE_PER_HOUR: one McpAuditLog.count per call on the (grantId, createdAt) index; correct across instances.
 */
const WINDOW_MS = 60_000;
const windows = new Map();

export function resetMinuteWindows() {
  windows.clear();
}

/** Records a call for `grantId` unless over the limit. Returns { ok } or { ok:false, retryAfterSec }. */
export function takeMinuteSlot(grantId, max, now = Date.now()) {
  const list = (windows.get(grantId) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= max) {
    windows.set(grantId, list);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((WINDOW_MS - (now - list[0])) / 1000)) };
  }
  list.push(now);
  windows.set(grantId, list);
  if (windows.size > 5000) {
    for (const [k, v] of windows) if (!v.length || now - v[v.length - 1] >= WINDOW_MS) windows.delete(k);
  }
  return { ok: true };
}

export async function checkHourLimit(db, grantId, max, now = new Date()) {
  const since = new Date(now.getTime() - 3_600_000);
  const n = await db.mcpAuditLog.count({ where: { grantId, createdAt: { gte: since } } });
  return n >= max ? { ok: false, retryAfterSec: 600 } : { ok: true };
}

/** Both limits. Returns { ok:true } or { ok:false, message, retryAfterSec }. */
export async function checkMcpLimits(db, grantId, cfg, now = new Date()) {
  const hour = await checkHourLimit(db, grantId, cfg.ratePerHour, now);
  if (!hour.ok) return { ok: false, retryAfterSec: hour.retryAfterSec, message: `MCP hourly limit reached (${cfg.ratePerHour} calls), retry later` };
  const minute = takeMinuteSlot(grantId, cfg.ratePerMin, now.getTime());
  if (!minute.ok) return { ok: false, retryAfterSec: minute.retryAfterSec, message: `rate limited, retry in ${minute.retryAfterSec} s` };
  return { ok: true };
}
