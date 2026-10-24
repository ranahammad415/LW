import jwt from 'jsonwebtoken';
import { prisma } from './prisma.js';
import { AUTH_USER_SELECT, authenticateApiToken, looksLikeApiToken } from './apiTokens.js';

const accessSecret = process.env.JWT_ACCESS_SECRET;
if (!accessSecret || accessSecret.length < 32) {
  throw new Error('JWT_ACCESS_SECRET must be set and at least 32 characters');
}

/**
 * Fastify preHandler / onRequest hook: verifies the Bearer credential and attaches the user to the request.
 * - `lwk_...` → per-user API token (lib/apiTokens.js): same user, same role, optionally narrower scopes.
 *   Sets request.authMethod = 'apiToken' and request.apiToken.
 * - anything else → access JWT. Sets request.authMethod = 'jwt'.
 */
export async function verifyJwt(request, reply) {
  const authHeader = request.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!token) {
    return reply.status(401).send({ message: 'Missing or invalid authorization token' });
  }

  if (looksLikeApiToken(token)) {
    return authenticateApiToken(request, reply, token);
  }

  try {
    const payload = jwt.verify(token, accessSecret);
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: AUTH_USER_SELECT,
    });

    if (!user || !user.isActive) {
      return reply.status(401).send({ message: 'User not found or inactive' });
    }

    // Invalidate access tokens issued before the user's most recent
    // password reset (or any other tokenVersion bump).
    if (typeof payload.tv === 'number' && payload.tv !== user.tokenVersion) {
      return reply.status(401).send({ message: 'Session invalidated. Please sign in again.' });
    }

    request.user = user;
    request.authMethod = 'jwt';
    // Remote MCP server (src/mcp/invoke.js): the 60 s internal JWT carries via:'mcp' and the grant id. No behaviour
    // change; lets routes and logs tell MCP-originated requests apart.
    request.viaMcp = payload.via === 'mcp';
    request.mcpGrantId = request.viaMcp && typeof payload.mg === 'string' ? payload.mg : null;
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return reply.status(401).send({ message: 'Access token expired' });
    }
    return reply.status(401).send({ message: 'Invalid token' });
  }
}
