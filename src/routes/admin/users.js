import bcrypt from 'bcrypt';
import { prisma } from '../../lib/prisma.js';
import { BCRYPT_ROUNDS, validatePasswordStrength } from '../../lib/passwordPolicy.js';

const CHANGE_PASSWORD_RATE_LIMIT = {
  max: Number(process.env.RATE_LIMIT_CHANGE_PASSWORD_MAX || 10),
  timeWindow: process.env.RATE_LIMIT_CHANGE_PASSWORD_WINDOW || '15 minutes',
};

export async function adminUserRoutes(app) {
  app.get(
    '/users',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            role: { type: 'string', enum: ['OWNER', 'PM', 'TEAM_MEMBER', 'CONTRACTOR'] },
          },
        },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                email: { type: 'string' },
                name: { type: 'string' },
                role: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { role } = request.query || {};
      const where = { isActive: true };
      if (role) {
        where.role = role;
      }
      const users = await prisma.user.findMany({
        where,
        select: { id: true, email: true, name: true, role: true },
        orderBy: [{ role: 'asc' }, { name: 'asc' }],
      });
      return reply.send(users);
    }
  );

  // ── Get own profile ──
  app.get(
    '/profile',
    { onRequest: [app.verifyJwt, app.requireOwner] },
    async (request, reply) => {
      const user = await prisma.user.findUnique({
        where: { id: request.user.id },
        select: { id: true, email: true, name: true, phone: true, timezone: true, avatarUrl: true, role: true },
      });
      if (!user) return reply.status(404).send({ message: 'User not found' });
      return reply.send(user);
    }
  );

  // ── Update own profile ──
  app.patch(
    '/profile',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 255 },
            phone: { type: 'string', maxLength: 50, nullable: true },
            timezone: { type: 'string', maxLength: 100, nullable: true },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, phone, timezone } = request.body;
      const data = {};
      if (name !== undefined) data.name = name;
      if (phone !== undefined) data.phone = phone;
      if (timezone !== undefined) data.timezone = timezone;

      if (Object.keys(data).length === 0) {
        return reply.status(400).send({ message: 'No fields to update' });
      }

      const user = await prisma.user.update({
        where: { id: request.user.id },
        data,
        select: { id: true, email: true, name: true, phone: true, timezone: true, avatarUrl: true, role: true },
      });
      return reply.send(user);
    }
  );

  // ── Change own password ──
  app.post(
    '/change-password',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      config: { rateLimit: CHANGE_PASSWORD_RATE_LIMIT },
      schema: {
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          properties: {
            currentPassword: { type: 'string', minLength: 1 },
            newPassword: { type: 'string', minLength: 10, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const { currentPassword, newPassword } = request.body;
      const strength = validatePasswordStrength(newPassword);
      if (!strength.ok) {
        return reply.status(400).send({ message: strength.message });
      }
      const user = await prisma.user.findUnique({
        where: { id: request.user.id },
        select: { id: true, passwordHash: true },
      });
      if (!user) return reply.status(404).send({ message: 'User not found' });

      const match = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!match) {
        return reply.status(400).send({ message: 'Current password is incorrect' });
      }

      const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          // Bump tokenVersion so existing sessions/refresh tokens are invalidated.
          tokenVersion: { increment: 1 },
        },
      });

      return reply.send({ message: 'Password updated successfully' });
    }
  );
}
