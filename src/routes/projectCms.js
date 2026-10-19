/**
 * EmDash site connection management (plan O4, contract §3.3, §4, §4.1). Mounted at /api/projects:
 *   POST /:id/cms/pairing-code   OWNER/PM with project access. Returns the one-time code ONCE.
 *   POST /:id/cms/rotate-keys    OWNER/PM. Stages a new key pair, delivered on the next heartbeat.
 *                                Body {revokePrev: true} (OWNER only, v1.5.6 §32.1): the old pair is refused at once.
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
  revisionAtLeast,
} from '../lib/siteAdapters/signing.js';
import { emdashRoutes, CmsBridgeError } from '../lib/siteAdapters/emdash.js';
import { loadEmdashConnection, sanitizeKeyState } from '../lib/cmsStore.js';
import { revokeConfirmOutcome } from '../lib/emdashSync.js';
import { validateSiteUrl } from '../lib/siteAdapters/netGuard.js';
import { sanitizeOutboxPause } from '../lib/siteAdapters/migration.js';

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
    // v1.5.0 §26.3: `mode: "migrate"` pairs the EmDash site that replaces this WordPress project's site (OWNER only).
    const migrate = request.body?.mode === 'migrate';
    if (migrate) {
      if (request.user.role !== 'OWNER') return reply.status(403).send({ message: 'Only an Owner can start a WordPress → EmDash migration.' });
      if (project.cmsType !== 'WORDPRESS') return reply.status(400).send({ message: 'Only a WordPress project can be migrated.' });
      if (project.cmsMigration?.state === 'applied') return reply.status(409).send({ message: 'This project was already migrated.' });
      if (!request.body?.siteUrl) return reply.status(400).send({ message: 'Enter the new EmDash site URL.' });
    } else if (project.cmsType !== 'EMDASH') {
      return reply.status(400).send({ message: 'Switch this project to EmDash before creating a pairing code.' });
    }
    if (!isCmsKeyCryptoConfigured()) return reply.status(503).send({ code: 'CMS_KEY_ENCRYPTION_KEY_MISSING', message: KEY_MISSING_MESSAGE });

    const site = await validateSiteUrl(migrate ? request.body.siteUrl : request.body?.siteUrl || project.wpUrl);
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
          mode: migrate ? 'migrate' : 'pair',
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

  // ── WordPress → EmDash migration (v1.5.0 §26.3, OWNER) ───────────────────
  // Status (no site call), preview (dry run: fetches the whole map, writes nothing but the preview), apply (one
  // transaction + cut-over; idempotent). See lib/cmsMigration.js for exactly what moves.
  const migrationError = (reply, err, log) => {
    if (err instanceof CmsBridgeError) {
      const status = err.status === 401 || (err.status >= 500 && err.status !== 503) ? 502 : err.status || 502;
      return reply.status(status).send({ code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
    }
    log?.error?.({ err }, 'Migration request failed');
    return reply.status(500).send({ message: 'Migration request failed' });
  };
  app.get('/:id/cms/migration', { onRequest: [app.verifyJwt, app.requireOwner] }, async (request, reply) => {
    const project = await prisma.project.findUnique({ where: { id: request.params.id }, select: { id: true, cmsType: true, wpUrl: true, cmsMigration: true, cmsPairedAt: true, cmsHealth: true } });
    if (!project) return reply.status(404).send({ message: 'Project not found' });
    // v1.5.3 §29: the paired site holds its events (no 72 h give-up) until the cut-over, at most until `until`.
    const outboxPaused = project.cmsType === 'WORDPRESS' && project.cmsMigration ? sanitizeOutboxPause(project.cmsHealth?.outbox?.paused) : null;
    return reply.send({ cmsType: project.cmsType, migration: project.cmsMigration || null, pairedAt: project.cmsPairedAt, outboxPaused });
  });
  app.post('/:id/cms/migration/preview', { onRequest: [app.verifyJwt, app.requireOwner] }, async (request, reply) => {
    try {
      const { previewMigration } = await import('../lib/cmsMigration.js');
      return reply.send(await previewMigration(request.params.id, { user: request.user, log: request.log }));
    } catch (err) {
      return migrationError(reply, err, request.log);
    }
  });
  app.post('/:id/cms/migration/apply', { onRequest: [app.verifyJwt, app.requireOwner] }, async (request, reply) => {
    try {
      if (request.body?.confirm !== true) return reply.status(400).send({ message: 'Confirm the migration.' });
      const { applyMigration } = await import('../lib/cmsMigration.js');
      const result = await applyMigration(request.params.id, {
        user: request.user,
        mapHash: request.body?.mapHash,
        confirmIdentity: request.body?.confirmIdentity === true,
        confirmEmpty: request.body?.confirmEmpty === true,
        log: request.log,
      });
      if (!result.alreadyApplied) {
        // After cut-over: import the EmDash inventory (time-boxed, fire-and-forget) and reconcile the maps.
        import('../lib/emdashSync.js').then((m) => m.scheduleInventoryAfterPairing(request.params.id, request.log, { delayMs: 1000 })).catch(() => {});
      }
      return reply.send({ success: true, result });
    } catch (err) {
      return migrationError(reply, err, request.log);
    }
  });

  // ── Disconnect (OWNER) ───────────────────────────────────────────────────
  // Deletes the HMAC keys, clears the paired state and stops polling (e2e OS issue 4). The siteId and
  // cursor stay so a later re-pair continues the same site (contract v1.0.3 §16(b)).
  app.post('/:id/cms/disconnect', { onRequest: [app.verifyJwt, app.requireOwner] }, async (request, reply) => {
    const project = await prisma.project.findUnique({ where: { id: request.params.id }, select: { id: true, cmsType: true } });
    if (!project) return reply.status(404).send({ message: 'Project not found' });
    if (project.cmsType !== 'EMDASH') return reply.status(400).send({ message: 'This project is not an EmDash site.' });
    const { prismaCmsStore } = await import('../lib/cmsStore.js');
    await prismaCmsStore.disconnect(project.id);
    request.log.info({ projectId: project.id }, 'EmDash site disconnected by OWNER');
    return reply.send({ success: true, message: 'Site disconnected. Create a pairing code to connect it again.' });
  });

  // ── Stage a key rotation ──────────────────────────────────────────────────
  app.post('/:id/cms/rotate-keys', { onRequest: [app.verifyJwt] }, async (request, reply) => {
    const project = await loadForStaff(request, reply);
    if (!project) return reply;
    if (project.cmsType !== 'EMDASH') return reply.status(400).send({ message: 'This project is not an EmDash site.' });
    if (!isCmsKeyCryptoConfigured()) return reply.status(503).send({ code: 'CMS_KEY_ENCRYPTION_KEY_MISSING', message: KEY_MISSING_MESSAGE });
    const revokePrev = request.body?.revokePrev === true;
    // v1.5.6 §32.1 compromise response: OWNER only; the site must understand revokePrev (1.5.6+), else the site would
    // keep the old pair for 24 h on its side: use Disconnect + a new pairing code for the same site instead.
    if (revokePrev && request.user.role !== 'OWNER') {
      return reply.status(403).send({ code: 'FORBIDDEN', message: 'Only the Owner can rotate keys with immediate revocation.' });
    }
    if (revokePrev && !revisionAtLeast(project.cmsHealth?.contractRevision, '1.5.6')) {
      return reply.status(409).send({
        code: 'SITE_TOO_OLD',
        message: "This site's bridge is older than contract 1.5.6 and cannot drop the old keys at once. Disconnect the site and create a new pairing code for it instead.",
      });
    }
    const cred = await prisma.cmsCredential.findUnique({ where: { projectId: project.id } });
    if (!cred) return reply.status(409).send({ message: 'Pair the site before rotating keys.' });

    const pendingKeyId = Math.max(cred.keyId, cred.pendingKeyId || 0) + 1;
    const r = await prisma.cmsCredential.updateMany({
      where: { projectId: project.id, keyId: cred.keyId },
      data: {
        pendingKeyId,
        // A normal rotation never downgrades a staged revoke (only the Owner stages one).
        pendingRevokePrev: revokePrev || cred.pendingRevokePrev === true,
        inboundKeyPendingEnc: encryptCmsSecret(generateKey(), cmsAad(project.id, 'inbound')),
        outboundKeyPendingEnc: encryptCmsSecret(generateKey(), cmsAad(project.id, 'outbound')),
        pendingCreatedAt: new Date(),
      },
    });
    if (r.count !== 1) return reply.status(409).send({ message: 'Keys changed meanwhile; try again.' });
    const revoking = revokePrev || cred.pendingRevokePrev === true;
    request.log.info({ projectId: project.id, pendingKeyId, revokePrev: revoking }, 'EmDash key rotation staged');
    return reply.send({
      success: true,
      currentKeyId: cred.keyId,
      pendingKeyId,
      revokePrev: revoking,
      message: revoking
        ? 'New keys are staged with immediate revocation: the next site heartbeat receives them and the old keys stop working at once. Agency OS then checks the site with the new keys.'
        : 'New keys are staged and will be delivered on the next site heartbeat. The previous keys stay valid for 24 hours after that.',
    });
  });

  // ── Health ────────────────────────────────────────────────────────────────
  app.get('/:id/cms/health', { onRequest: [app.verifyJwt] }, async (request, reply) => {
    const project = await loadForStaff(request, reply);
    if (!project) return reply;
    const cred = project.cmsType === 'EMDASH'
      ? await prisma.cmsCredential.findUnique({
          where: { projectId: project.id },
          select: { keyId: true, pendingKeyId: true, prevKeyId: true, prevExpiresAt: true, rotatedAt: true, pendingRevokePrev: true, prevRevokedAt: true, revokeConfirmedAt: true, revokeConfirmError: true },
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
      // v1.5.6 §32.1 revoke-now state (OS side).
      pendingRevokePrev: cred?.pendingRevokePrev === true,
      prevRevokedAt: cred?.prevRevokedAt || null,
      revokeConfirmedAt: cred?.revokeConfirmedAt || null,
      revokeConfirmError: cred?.revokeConfirmError || null,
      revokeSupported: revisionAtLeast(project.cmsHealth?.contractRevision, '1.5.6'),
      contractVersion: project.cmsContractVersion ?? null,
      contractRevision: project.cmsHealth?.contractRevision ?? null,
      previewConfigured: project.cmsHealth?.previewConfigured ?? null,
      disconnectedAt: project.cmsDisconnectedAt || null,
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
    // v1.5.6 §32.1: the site's key state (never a key): live health first, else the stored heartbeat value.
    body.siteKeys = sanitizeKeyState(body.live?.keys) || sanitizeKeyState(project.cmsHealth?.keys);
    // A live check signed with the new key that shows the revoke also confirms it (same rule as the automatic check).
    if (body.live?.ok !== false && body.live && cred?.prevRevokedAt && !cred.revokeConfirmedAt) {
      const outcome = revokeConfirmOutcome(body.live, { keyId: cred.keyId, rotatedAt: cred.prevRevokedAt });
      if (outcome.ok) {
        await prisma.cmsCredential.updateMany({ where: { projectId: project.id, keyId: cred.keyId }, data: { revokeConfirmedAt: new Date(), revokeConfirmError: null } });
        body.revokeConfirmedAt = new Date();
        body.revokeConfirmError = null;
      }
    }
    // v1.5.3 §29: outbox give-up pause (live health first, else the stored handshake/site-info value).
    body.outboxPaused = sanitizeOutboxPause(body.live?.outbox?.paused) || sanitizeOutboxPause(project.cmsHealth?.outbox?.paused);
    return reply.send(body);
  });
}
