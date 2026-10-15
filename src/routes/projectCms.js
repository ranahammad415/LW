/**
 * EmDash site connection management (plan O4, contract §3.3, §4, §4.1). Mounted at /api/projects:
 *   POST /:id/cms/pairing-code   OWNER/PM with project access. Returns the one-time code ONCE.
 *   POST /:id/cms/rotate-keys    OWNER/PM. Stages a new key pair, delivered on the next heartbeat.
 *   GET  /:id/cms/health         OWNER/PM. Stored handshake health (+ live `health` call with ?live=1).
 *
 * The pairing code is never stored: only its verifier and the AES-GCM encrypted pairing signing key
 * (deleted on use, burn or expiry). EmDash features fail closed without CMS_KEY_ENCRYPTION_KEY.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { prisma } from '../lib/prisma.js';
import { ensureProjectAccess } from '../lib/ensureProjectAccess.js';
import { encryptCmsSecret, isCmsKeyCryptoConfigured } from '../lib/cmsKeyCrypto.js';
import {
  PAIRING_CODE_TTL_SEC,
  SUPPORTED_CONTRACTS,
  createPairingCode,
  generateKey,
  generateSiteId,
  pairingSigningKey,
  pairingVerifier,
} from '../lib/siteAdapters/signing.js';
import { emdashRoutes, CmsBridgeError } from '../lib/siteAdapters/emdash.js';
import { loadEmdashConnection } from '../lib/cmsStore.js';

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const KEY_MISSING_MESSAGE =
  'CMS_KEY_ENCRYPTION_KEY is not set on Agency OS. Ask the administrator to set it (32+ random characters) before connecting EmDash sites.';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}

/**
 * The OS only ever calls the URL stored here (never one sent by the site), so it is
 * validated once: https (http://localhost allowed outside production), no query/fragment,
 * and in production the host must resolve to public addresses only (SSRF, plan §6).
 */
export async function validateSiteUrl(raw, { env = process.env, lookup = dns.lookup } = {}) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    return { ok: false, message: 'Enter the full site URL, e.g. https://example.com' };
  }
  const isProd = env.NODE_ENV === 'production';
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && localHost && !isProd)) {
    return { ok: false, message: 'The site URL must use https://' };
  }
  if (u.search || u.hash || u.username || u.password) {
    return { ok: false, message: 'The site URL must not carry a query string, fragment or credentials' };
  }
  if (isProd) {
    if (localHost) return { ok: false, message: 'The site URL must be a public https address' };
    try {
      const addrs = await lookup(u.hostname, { all: true });
      if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
        return { ok: false, message: 'The site URL must resolve to a public address' };
      }
    } catch {
      return { ok: false, message: 'The site URL host could not be resolved' };
    }
  }
  const path = u.pathname.replace(/\/+$/, '');
  return { ok: true, url: `${u.origin}${path}`.slice(0, 500) };
}

export async function projectCmsRoutes(app) {
  async function loadForStaff(request, reply) {
    const { user } = request;
    if (user.role !== 'OWNER' && user.role !== 'PM') {
      reply.status(403).send({ message: 'Only Owner or PM can manage the site connection' });
      return null;
    }
    const project = await prisma.project.findUnique({
      where: { id: request.params.id },
      include: { client: { select: { leadPmId: true, secondaryPmId: true } } },
    });
    if (!project) {
      reply.status(404).send({ message: 'Project not found' });
      return null;
    }
    if (!(await ensureProjectAccess(project, user))) {
      reply.status(403).send({ message: 'You do not have access to this project' });
      return null;
    }
    return project;
  }

  // ── Pairing code (shown once) ─────────────────────────────────────────────
  app.post('/:id/cms/pairing-code', { onRequest: [app.verifyJwt] }, async (request, reply) => {
    const project = await loadForStaff(request, reply);
    if (!project) return reply;
    if (project.cmsType !== 'EMDASH') {
      return reply.status(400).send({ message: 'Switch this project to EmDash before creating a pairing code.' });
    }
    if (!isCmsKeyCryptoConfigured()) return reply.status(503).send({ code: 'CMS_KEY_ENCRYPTION_KEY_MISSING', message: KEY_MISSING_MESSAGE });

    const site = await validateSiteUrl(request.body?.siteUrl || project.wpUrl);
    if (!site.ok) return reply.status(400).send({ message: site.message });

    const siteId = project.cmsSiteId || generateSiteId();
    const code = createPairingCode(siteId);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_SEC * 1000);

    await prisma.$transaction([
      // A new code replaces any unused one (its signing key is deleted).
      prisma.cmsPairingCode.updateMany({
        where: { projectId: project.id, usedAt: null, burnedAt: null },
        data: { burnedAt: now, signingKeyEnc: null },
      }),
      prisma.project.update({ where: { id: project.id }, data: { cmsSiteId: siteId, wpUrl: site.url } }),
      prisma.cmsPairingCode.create({
        data: {
          projectId: project.id,
          siteId,
          verifier: pairingVerifier(code),
          signingKeyEnc: encryptCmsSecret(pairingSigningKey(code)),
          expiresAt,
          createdById: request.user.id,
        },
      }),
    ]);
    request.log.info({ projectId: project.id, siteId }, 'EmDash pairing code created');

    reply.header('cache-control', 'no-store');
    return reply.send({
      code,
      siteId,
      siteUrl: site.url,
      expiresAt: expiresAt.toISOString(),
      ttlSeconds: PAIRING_CODE_TTL_SEC,
      message: 'Paste this code into the site admin (Plugins → Agency OS bridge → Pair). It is shown only once and expires in 15 minutes.',
    });
  });

  // ── Stage a key rotation ──────────────────────────────────────────────────
  app.post('/:id/cms/rotate-keys', { onRequest: [app.verifyJwt] }, async (request, reply) => {
    const project = await loadForStaff(request, reply);
    if (!project) return reply;
    if (project.cmsType !== 'EMDASH') return reply.status(400).send({ message: 'This project is not an EmDash site.' });
    if (!isCmsKeyCryptoConfigured()) return reply.status(503).send({ code: 'CMS_KEY_ENCRYPTION_KEY_MISSING', message: KEY_MISSING_MESSAGE });
    const cred = await prisma.cmsCredential.findUnique({ where: { projectId: project.id } });
    if (!cred) return reply.status(409).send({ message: 'Pair the site before rotating keys.' });

    const pendingKeyId = Math.max(cred.keyId, cred.pendingKeyId || 0) + 1;
    const r = await prisma.cmsCredential.updateMany({
      where: { projectId: project.id, keyId: cred.keyId },
      data: {
        pendingKeyId,
        inboundKeyPendingEnc: encryptCmsSecret(generateKey()),
        outboundKeyPendingEnc: encryptCmsSecret(generateKey()),
        pendingCreatedAt: new Date(),
      },
    });
    if (r.count !== 1) return reply.status(409).send({ message: 'Keys changed meanwhile; try again.' });
    request.log.info({ projectId: project.id, pendingKeyId }, 'EmDash key rotation staged');
    return reply.send({
      success: true,
      currentKeyId: cred.keyId,
      pendingKeyId,
      message: 'New keys are staged and will be delivered on the next site heartbeat. The previous keys stay valid for 24 hours after that.',
    });
  });

  // ── Health ────────────────────────────────────────────────────────────────
  app.get('/:id/cms/health', { onRequest: [app.verifyJwt] }, async (request, reply) => {
    const project = await loadForStaff(request, reply);
    if (!project) return reply;
    const cred = project.cmsType === 'EMDASH'
      ? await prisma.cmsCredential.findUnique({
          where: { projectId: project.id },
          select: { keyId: true, pendingKeyId: true, prevKeyId: true, prevExpiresAt: true, rotatedAt: true },
        })
      : null;
    const lastCode = project.cmsType === 'EMDASH'
      ? await prisma.cmsPairingCode.findFirst({
          where: { projectId: project.id },
          orderBy: { createdAt: 'desc' },
          select: { expiresAt: true, usedAt: true, burnedAt: true, failedAttempts: true, createdAt: true },
        })
      : null;
    const lastSeenMs = project.cmsLastSeenAt ? new Date(project.cmsLastSeenAt).getTime() : null;
    const body = {
      cmsType: project.cmsType,
      siteUrl: project.wpUrl || null,
      siteId: project.cmsSiteId || null,
      paired: !!(cred && project.cmsPairedAt),
      pairedAt: project.cmsPairedAt || null,
      lastSeenAt: project.cmsLastSeenAt || null,
      stale: lastSeenMs == null ? !!project.cmsPairedAt : Date.now() - lastSeenMs > STALE_AFTER_MS,
      keyId: cred?.keyId ?? null,
      pendingKeyId: cred?.pendingKeyId ?? null,
      prevKeyExpiresAt: cred?.prevExpiresAt || null,
      rotatedAt: cred?.rotatedAt || null,
      contractVersion: project.cmsContractVersion ?? null,
      supportedContracts: [...SUPPORTED_CONTRACTS],
      contractSupported: project.cmsContractVersion == null || SUPPORTED_CONTRACTS.includes(project.cmsContractVersion),
      pluginVersion: project.cmsPluginVersion || null,
      capabilities: project.cmsCapabilities || null,
      health: project.cmsHealth || null,
      lastCursor: project.cmsLastCursor ?? null,
      encryptionConfigured: isCmsKeyCryptoConfigured(),
      pairingCode: lastCode
        ? {
            createdAt: lastCode.createdAt,
            expiresAt: lastCode.expiresAt,
            used: !!lastCode.usedAt,
            burned: !!lastCode.burnedAt,
            failedAttempts: lastCode.failedAttempts,
          }
        : null,
      live: null,
    };
    if (request.query?.live === '1' && body.paired) {
      try {
        const { conn } = await loadEmdashConnection(project.id);
        body.live = await emdashRoutes.health(conn, { retryDelays: [], timeoutMs: 8000 });
      } catch (err) {
        body.live = {
          ok: false,
          error: {
            code: err instanceof CmsBridgeError ? err.code : 'INTERNAL',
            message: err instanceof CmsBridgeError ? err.message : 'Health check failed',
          },
        };
      }
    }
    return reply.send(body);
  });
}
