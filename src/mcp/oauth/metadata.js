/**
 * Discovery documents: OAuth protected resource metadata (RFC 9728) and authorization server metadata (RFC 8414).
 * Public JSON, `Cache-Control: no-store`, CORS `*` (no credentials). URLs derive from MCP_PUBLIC_URL only.
 */
import { MCP_SCOPES } from '../config.js';

export function protectedResourceMetadata(cfg) {
  return {
    resource: cfg.resource,
    authorization_servers: [cfg.issuer],
    scopes_supported: MCP_SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'LocalWaves Agency OS',
  };
}

export function authorizationServerMetadata(cfg) {
  const base = cfg.issuer;
  return {
    issuer: base,
    authorization_endpoint: `${base}/api/mcp/oauth/authorize`,
    token_endpoint: `${base}/api/mcp/oauth/token`,
    registration_endpoint: `${base}/api/mcp/oauth/register`,
    revocation_endpoint: `${base}/api/mcp/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: MCP_SCOPES,
    resource_indicators_supported: true,
  };
}

/** Headers for public OAuth JSON (discovery, register, token, revoke). */
export function publicJsonHeaders(reply) {
  reply.header('Cache-Control', 'no-store');
  reply.header('Pragma', 'no-cache');
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  reply.removeHeader('Access-Control-Allow-Credentials');
  return reply;
}

export async function metadataRoutes(app, { cfg }) {
  const prm = protectedResourceMetadata(cfg);
  const asm = authorizationServerMetadata(cfg);
  const sendPrm = async (_request, reply) => publicJsonHeaders(reply).send(prm);
  app.get(`/.well-known/oauth-protected-resource${cfg.resourcePath}`, sendPrm);
  app.get('/.well-known/oauth-protected-resource', sendPrm);
  app.get('/.well-known/oauth-authorization-server', async (_request, reply) => publicJsonHeaders(reply).send(asm));
}
