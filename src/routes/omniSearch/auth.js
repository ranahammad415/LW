import crypto from 'crypto';
import bcrypt from 'bcrypt';

// ─── In-memory token store ──────────────────────────────────────────────────
const tokens = new Map(); // token -> { createdAt, ip }

// ─── Password helpers ───────────────────────────────────────────────────────
const DEFAULT_PASSWORD = 'omnisearch2026';

async function getPasswordHash() {
  if (process.env.OMNISEARCH_PASSWORD_HASH) return process.env.OMNISEARCH_PASSWORD_HASH;
  if (process.env.TOOL_PASSWORD_HASH) return process.env.TOOL_PASSWORD_HASH;
  const hash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  OMNISEARCH_PASSWORD_HASH not set in .env                   ║');
  console.log('║  Generated hash for default password "omnisearch2026":      ║');
  console.log(`║  ${hash}`);
  console.log('║  Add this to your .env as OMNISEARCH_PASSWORD_HASH          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  return hash;
}

// ─── Token generation ───────────────────────────────────────────────────────
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ─── Auth guard (preHandler) ────────────────────────────────────────────────
export async function verifyOmniSearchToken(request, reply) {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.code(401).send({ success: false, error: 'Not authenticated' });
  }
  const token = authHeader.slice(7);
  if (!tokens.has(token)) {
    return reply.code(401).send({ success: false, error: 'Invalid or expired token' });
  }
}

// ─── Rate limiter (simple in-memory) ────────────────────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 min
const RATE_LIMIT_MAX = 10;

function rateLimit(request, reply, done) {
  const ip = request.ip;
  const now = Date.now();
  if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
  const timestamps = rateLimitMap.get(ip).filter(t => now - t < RATE_LIMIT_WINDOW);
  if (timestamps.length >= RATE_LIMIT_MAX) {
    reply.code(429).send({ success: false, error: 'Rate limit exceeded. Try again in 15 minutes.' });
    return;
  }
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  done();
}

// ─── Fastify plugin ─────────────────────────────────────────────────────────
export default async function authRoutes(app) {
  // Decorate so other sub-routes can use app.omniSearchAuth as preHandler
  app.decorate('omniSearchAuth', verifyOmniSearchToken);

  // POST /auth/login
  app.post('/auth/login', {
    preHandler: [(req, rep, done) => rateLimit(req, rep, done)],
  }, async (request, reply) => {
    const { password } = request.body || {};
    if (!password) {
      return reply.code(400).send({ success: false, error: 'Password required' });
    }

    const hash = await getPasswordHash();
    const match = await bcrypt.compare(password, hash);
    if (!match) {
      return reply.code(401).send({ success: false, error: 'Incorrect password' });
    }

    const token = generateToken();
    tokens.set(token, { createdAt: Date.now(), ip: request.ip });
    return { success: true, token };
  });

  // POST /auth/logout
  app.post('/auth/logout', {
    preHandler: [verifyOmniSearchToken],
  }, async (request) => {
    const token = request.headers.authorization.slice(7);
    tokens.delete(token);
    return { success: true };
  });

  // GET /auth/check
  app.get('/auth/check', async (request) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { success: true, authenticated: false };
    }
    return { success: true, authenticated: tokens.has(authHeader.slice(7)) };
  });
}
