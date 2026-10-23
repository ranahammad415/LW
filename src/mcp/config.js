/**
 * Remote MCP server configuration (docs/ledger/features/mcp-server.md, env-vars.md "Backend: MCP server").
 * Read once at boot. Nothing MCP-related is registered unless MCP_ENABLED === 'true'.
 *
 * MCP_PUBLIC_URL is the exact public URL of the MCP endpoint (e.g. https://account.localwaves.ai/api/mcp). The
 * canonical resource URI (RFC 8707) is that URL; the OAuth issuer is its origin.
 */
const ROLES = ['OWNER', 'PM', 'TEAM_MEMBER', 'CONTRACTOR', 'CLIENT'];
const DEFAULT_REDIRECT_HOSTS = 'claude.ai,claude.com,anthropic.com,localhost,127.0.0.1';
const DEFAULT_CORS = 'https://claude.ai,https://claude.com';

export const MCP_SCOPES = ['os:read', 'os:write'];

function bool(v) {
  return String(v ?? '').trim().toLowerCase() === 'true';
}

function int(v, def, min, max) {
  const n = Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function list(v) {
  return String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function originOf(u) {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

function isLoopbackHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/** Builds the config from env. `errors` lists what makes an enabled config unusable. */
export function loadMcpConfig(env = process.env) {
  const enabled = bool(env.MCP_ENABLED);
  const errors = [];
  let resource = null;
  let issuer = null;
  let resourcePath = '/api/mcp';
  const raw = String(env.MCP_PUBLIC_URL || '').trim();
  if (raw) {
    try {
      const u = new URL(raw);
      const path = u.pathname.replace(/\/+$/, '') || '/';
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) {
        errors.push('MCP_PUBLIC_URL must be https (http only for localhost)');
      }
      if (u.search || u.hash) errors.push('MCP_PUBLIC_URL must not have a query or fragment');
      if (path !== '/api/mcp') errors.push('MCP_PUBLIC_URL path must be /api/mcp');
      resourcePath = path;
      resource = `${u.origin}${path}`;
      issuer = u.origin;
    } catch {
      errors.push('MCP_PUBLIC_URL is not a valid URL');
    }
  } else {
    errors.push('MCP_PUBLIC_URL is required when MCP_ENABLED=true');
  }

  const frontendOrigins = list(env.FRONTEND_URL).map(originOf).filter(Boolean);
  const spaUrl = String(env.MCP_SPA_URL || '').trim().replace(/\/+$/, '') || (list(env.FRONTEND_URL)[0] || 'http://localhost:5173').replace(/\/+$/, '');
  const spaOrigin = originOf(spaUrl);
  if (!spaOrigin) errors.push('MCP_SPA_URL / FRONTEND_URL must be a valid URL');
  const consentOrigins = [...new Set([...frontendOrigins, spaOrigin].filter(Boolean))];

  const allowedRoles = list(env.MCP_ALLOWED_ROLES || 'OWNER').map((r) => r.toUpperCase()).filter((r) => ROLES.includes(r));
  if (allowedRoles.length === 0) errors.push('MCP_ALLOWED_ROLES has no valid role');

  const corsOrigins = [...new Set([...list(env.MCP_CORS_ORIGINS || DEFAULT_CORS).map(originOf).filter(Boolean), ...frontendOrigins])];

  return {
    enabled,
    errors: enabled ? errors : [],
    resource,
    resourcePath,
    issuer,
    resourceMetadataUrl: issuer ? `${issuer}/.well-known/oauth-protected-resource${resourcePath}` : null,
    spaUrl,
    consentOrigins,
    allowedRoles,
    redirectHosts: list(env.MCP_REDIRECT_HOST_ALLOWLIST || DEFAULT_REDIRECT_HOSTS).map((h) => h.toLowerCase()),
    corsOrigins,
    accessTtlSec: int(env.MCP_ACCESS_TTL_SEC, 3600, 300, 86_400),
    refreshTtlDays: int(env.MCP_REFRESH_TTL_DAYS, 30, 1, 90),
    grantMaxDays: int(env.MCP_GRANT_MAX_DAYS, 90, 1, 365),
    toolTimeoutMs: int(env.MCP_TOOL_TIMEOUT_MS, 45_000, 1_000, 90_000),
    maxResultBytes: int(env.MCP_MAX_RESULT_BYTES, 200_000, 10_000, 1_000_000),
    ratePerMin: int(env.MCP_RATE_PER_MIN, 60, 1, 1_000),
    ratePerHour: int(env.MCP_RATE_PER_HOUR, 600, 1, 20_000),
    auditRetentionDays: int(env.MCP_AUDIT_RETENTION_DAYS, 180, 7, 3_650),
    authRequestTtlSec: 600,
    codeTtlSec: 300,
    confirmTtlSec: 300,
  };
}
