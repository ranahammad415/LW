import jwt from 'jsonwebtoken';
import { prisma } from './prisma.js';

const accessSecret = process.env.JWT_ACCESS_SECRET;
if (!accessSecret || accessSecret.length < 32) {
  throw new Error('JWT_ACCESS_SECRET must be set and at least 32 characters');
}

/**
 * Fastify preHandler / onRequest hook: verifies JWT from Authorization header
 * and attaches user to request. Call after cookie is parsed if using cookies.
 */
export async function verifyJwt(request, reply) {
  const authHeader = request.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return reply.status(401).send({ message: 'Missing or invalid authorization token' });
  }

  try {
    const payload = jwt.verify(token, accessSecret);
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        role: true,
        name: true,
        avatarUrl: true,
        phone: true,
        timezone: true,
        isActive: true,
        tokenVersion: true,
      },
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
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return reply.status(401).send({ message: 'Access token expired' });
    }
    return reply.status(401).send({ message: 'Invalid token' });
  }
}
