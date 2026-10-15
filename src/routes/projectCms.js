/**
 * EmDash site connection management (plan O4, contract §3.3, §4, §4.1). Mounted at /api/projects:
 *   POST /:id/cms/pairing-code   OWNER/PM with project access. Returns the one-time code ONCE.
 *   POST /:id/cms/rotate-keys    OWNER/PM. Stages a new key pair, delivered on the next heartbeat.
 *   GET  /:id/cms/health         OWNER/PM. Stored handshake health (+ live `health` call with ?live=1).
 *
 * The pairing code is never stored: only its verifier and the AES-GCM encrypted pairing signing key
 * (deleted on use, burn or expiry). EmDash features fail closed without CMS_KEY_ENCRYPTION_KEY.
 */
import { prisma } from '../lib/prisma.js';
import { ensureProjectAccess } from '../lib/ensureProjectAccess.js';
import { encryptCmsSecret, isCmsKeyCryptoConfigured, cmsAad } from '../lib/cmsKeyCrypto.js';
import {
  PAIRING_CODE_TTL_SEC,
  CONTRACT_REVISION,
  SUPPORTED_CONTRACTS,
  createPairingCode,
  generateKey,
  generateSiteId,
  pairingSigningKey,
  pairingVerifier,
} from '../lib/siteAdapters/signing.js';
import { emdashRoutes, CmsBridgeError } from '../lib/siteAdapters/emdash.js';
import { loadEmdashConnection } from '../lib/cmsStore.js';
import { validateSiteUrl } from '../lib/siteAdapters/netGuard.js';

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const KEY_MISSING_MESSAGE =
  'CMS_KEY_ENCRYPTION_KEY is not set on Agency OS. Ask the administrator to set it (32+ random characters) before connecting EmDash sites.';

export { validateSiteUrl };

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

    // Counters never reset on the site (contract v1.0.2 C1): re-pairing reuses the project's siteId.
    // `newSite: true` (site lost its plugin storage / fresh install) mints a new siteId instead.
    const newSite = request.body?.newSite === true;
    const siteId = !newSite && project.cmsSiteId ? project.cmsSiteId : generateSiteId();
    const code = createPairingCode(siteId);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_SEC * 1000);

    await prisma.$transaction([
      // A new code replaces any unused one (its signing key is deleted).
      prisma.cmsPairingCode.updateMany({
        where: { projectId: project.id, usedAt: null, burnedAt: null },
        data: { burnedAt: now, signingKeyEnc: null },
      }),
      // Project.wpUrl / cmsSiteId change only when pairing completes, so a live credential keeps
      // talking to the current site until the new one has paired (review S11).
      prisma.cmsPairingCode.create({
        data: {
          projectId: project.id,
          siteId,
          siteUrl: site.url,
          verifier: pairingVerifier(code),
          signingKeyEnc: encryptCmsSecret(pairingSigningKey(code), cmsAad(project.id, 'pairing')),
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
      newSite: siteId !== project.cmsSiteId,
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
        inboundKeyPendingEnc: encryptCmsSecret(generateKey(), cmsAad(project.id, 'inbound')),
        outboundKeyPendingEnc: encryptCmsSecret(generateKey(), cmsAad(project.id, 'outbound')),
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
          select: { expiresAt: true, usedAt: true, burnedAt: true, failedAttempts: true, createdAt: true, siteId: true, siteUrl: true },
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
      contractRevision: project.cmsHealth?.contractRevision ?? null,
      osContractRevision: CONTRACT_REVISION,
      supportedContracts: [...SUPPORTED_CONTRACTS],
      contractSupported: project.cmsContractVersion == null || SUPPORTED_CONTRACTS.includes(project.cmsContractVersion),
      pluginVersion: project.cmsPluginVersion || null,
      capabilities: project.cmsCapabilities || null,
      health: project.cmsHealth || null,
      lastCursor: project.cmsLastCursor ?? null,
      repairNeeded: project.cmsRepairNeededAt
        ? { at: project.cmsRepairNeededAt, reason: project.cmsRepairReason || null }
        : null,
      encryptionConfigured: isCmsKeyCryptoConfigured(),
      pairingCode: lastCode
        ? {
            createdAt: lastCode.createdAt,
            expiresAt: lastCode.expiresAt,
            used: !!lastCode.usedAt,
            burned: !!lastCode.burnedAt,
            failedAttempts: lastCode.failedAttempts,
            siteId: lastCode.siteId,
            siteUrl: lastCode.siteUrl || null,
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
