import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.js';
import { subscribe } from '../lib/realtimeBus.js';

const accessSecret = process.env.JWT_ACCESS_SECRET;

// Resolve the JWT either from the Authorization header (server-to-server,
// curl) or from a `?token=` query string (the only practical option for the
// browser EventSource API, which cannot set custom headers).
async function resolveUser(request) {
  let token = null;
  const auth = request.headers?.authorization;
  if (auth?.startsWith('Bearer ')) token = auth.slice(7);
  if (!token && typeof request.query?.token === 'string') token = request.query.token;
  if (!token) return null;

  try {
    const payload = jwt.verify(token, accessSecret);
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true, isActive: true, tokenVersion: true },
    });
    if (!user || !user.isActive) return null;
    if (typeof payload.tv === 'number' && payload.tv !== user.tokenVersion) return null;
    return user;
  } catch {
    return null;
  }
}

// Verify the authenticated user has access to the project.
async function userCanAccessProject(user, projectId) {
  if (!user || !projectId) return false;
  if (user.role === 'OWNER') return true;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, clientId: true, leadPmId: true, secondaryPmId: true },
  });
  if (!project) return false;

  if (user.role === 'PM') {
    return project.leadPmId === user.id || project.secondaryPmId === user.id;
  }

  if (user.role === 'CLIENT') {
    if (!project.clientId) return false;
    const link = await prisma.clientUser.findFirst({
      where: { userId: user.id, clientId: project.clientId },
      select: { id: true },
    });
    return Boolean(link);
  }

  return false;
}

export async function realtimeRoutes(app) {
  app.get('/:projectId', async (request, reply) => {
    const { projectId } = request.params;

    const user = await resolveUser(request);
    if (!user) return reply.status(401).send({ message: 'Unauthorized' });

    const allowed = await userCanAccessProject(user, projectId);
    if (!allowed) return reply.status(403).send({ message: 'Forbidden' });

    // Take over the underlying socket so Fastify does not buffer the
    // response or attach a Content-Length header.
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    // Initial hello frame so the client knows the stream is live.
    res.write(`event: hello\ndata: ${JSON.stringify({ projectId, ts: Date.now() })}\n\n`);

    const unsubscribe = subscribe(projectId, res, user.id);

    // Heartbeat every 25s — comments are ignored by EventSource but keep
    // proxies / load balancers from killing the idle connection.
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* socket closed */ }
    }, 25_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      try { res.end(); } catch { /* already closed */ }
    };

    request.raw.on('close', cleanup);
    request.raw.on('aborted', cleanup);
  });
}
