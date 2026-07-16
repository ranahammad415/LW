import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const secret = process.env.JWT_ACCESS_SECRET;
if (!secret || secret.length < 32) {
  console.error('JWT_ACCESS_SECRET missing or too short — load backend/.env');
  process.exit(1);
}
const base = 'http://localhost:3000/api';

function token(user) {
  return jwt.sign({ sub: user.id, role: user.role, tv: user.tokenVersion ?? 0 }, secret, { expiresIn: '1h' });
}

async function hit(label, path, tok, method = 'GET', timeoutMs = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      signal: ac.signal,
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 200);
    }
    const brief =
      typeof body === 'object' ? JSON.stringify(body).slice(0, 280) : String(body).slice(0, 280);
    console.log(JSON.stringify({ label, status: res.status, ok: res.ok, brief }));
    return { status: res.status, ok: res.ok, body };
  } catch (e) {
    console.log(JSON.stringify({ label, error: e.name === 'AbortError' ? `timeout ${timeoutMs}ms` : e.message }));
    return { error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

const owner = await prisma.user.findFirst({ where: { role: 'OWNER', isActive: true } });
const clientUser = await prisma.user.findFirst({
  where: { role: 'CLIENT', isActive: true },
  include: { clientAccess: { take: 1 } },
});
const pm = await prisma.user.findFirst({ where: { role: 'PM', isActive: true } });

const ot = token(owner);
const ct = clientUser ? token(clientUser) : null;
const pt = pm ? token(pm) : null;
await prisma.$disconnect();

console.log('OWNER', owner.email);
await hit('google-status', '/admin/integrations/google/status', ot);
await hit('integration-projects', '/admin/integrations/projects', ot);
await hit('work-cycles', '/work-cycles', ot);
await hit('work-cycles-current', '/work-cycles/current', ot);
await hit('open-next-preview', '/admin/work-cycles/open-next/preview', ot);

if (clientUser && ct) {
  console.log('CLIENT', clientUser.email);
  await hit('client-analytics-overview', '/client/analytics/overview', ct);
  await hit('client-analytics-gsc-organic', '/client/analytics/gsc/organic', ct);
  await hit('client-analytics-ga4-channels', '/client/analytics/ga4/channels', ct);
  await hit('client-analytics-gmb-overview', '/client/analytics/gmb/overview', ct);
  await hit('client-analytics-llm-visibility', '/client/analytics/llm/visibility', ct);
  await hit('client-analytics-seo', '/client/analytics/seo/keywords', ct);
  await hit('client-analytics-native', '/client/analytics/native', ct);
  await hit('client-tasks', '/client/tasks', ct);
  await hit('client-reports', '/client/reports', ct);
} else {
  console.log('NO_CLIENT_USER');
}

if (pm && pt) {
  console.log('PM', pm.email);
  await hit('pm-pipeline', '/pm/pipeline', pt);
  await hit('pm-tasks', '/tasks', pt);
}

const prisma2 = new PrismaClient();
const projects = await prisma2.project.count();
const withGsc = await prisma2.project.count({ where: { gscSiteUrl: { not: null } } });
const withGa4 = await prisma2.project.count({ where: { ga4PropertyId: { not: null } } });
const withGmb = await prisma2.project.count({ where: { gmbLocationId: { not: null } } });
const gscDaily = await prisma2.gscDailyMetric.count();
const cycles = await prisma2.workCycle.count();
console.log(JSON.stringify({ projects, withGsc, withGa4, withGmb, gscDaily, cycles }));
await prisma2.$disconnect();
