/**
 * Prisma-backed persistence for the EmDash bridge (contract agency-os-bridge/v1).
 * The webhook route (routes/webhooks/emdash.js) takes this store by injection so its
 * verification / ordering logic can be unit-tested with an in-memory store.
 *
 * Every "check then write" here is atomic across PM2 instances: unique indexes
 * (CmsNonce, CmsEventReceipt) or compare-and-set `updateMany ... count === 1`.
 */
import { prisma } from './prisma.js';
import { encryptCmsSecret, decryptCmsSecret } from './cmsKeyCrypto.js';
import { applyReviewEvent } from './reviewEvents.js';
import { isPipelineTombstoned } from './pipelineReviewGuard.js';
import { reconcileProjectMapsSafe, mirrorPipelineToMaps } from './contentMapSync.js';
import { commentsForEventType } from './pipelineFormat.js';
import {
  connectionFor,
  entryToPageData,
  reviewToMirrorData,
  CmsBridgeError,
} from './siteAdapters/emdash.js';
import { KEY_ROTATION_OVERLAP_SEC, PAIRING_MAX_FAILED_ATTEMPTS } from './siteAdapters/signing.js';

/** Receipts stuck in `pending` longer than this (crashed worker) may be re-claimed. */
const STALE_CLAIM_MS = 5 * 60 * 1000;

export const PROJECT_CMS_SELECT = {
  id: true,
  name: true,
  clientId: true,
  leadPmId: true,
  cmsType: true,
  wpUrl: true,
  cmsSiteId: true,
  cmsKeyId: true,
  cmsContractVersion: true,
  cmsPluginVersion: true,
  cmsCapabilities: true,
  cmsHealth: true,
  cmsPairedAt: true,
  cmsLastSeenAt: true,
  cmsLastCursor: true,
};

function isUniqueViolation(err) {
  return err && (err.code === 'P2002' || /Unique constraint/i.test(String(err.message || '')));
}

/** Load an EmDash project + decrypted connection for OS → site calls. Throws CmsBridgeError. */
export async function loadEmdashConnection(projectId) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: PROJECT_CMS_SELECT });
  if (!project) throw new CmsBridgeError({ status: 404, code: 'NOT_FOUND', message: 'Project not found' });
  const credential = project.cmsType === 'EMDASH'
    ? await prisma.cmsCredential.findUnique({ where: { projectId } })
    : null;
  return { project, conn: connectionFor(project, credential) };
}

/** Lead PM + secondary PM of the project's client, as contract `member`s (fallback: active OWNERs). */
async function listPms(project) {
  const ids = new Set();
  if (project.leadPmId) ids.add(project.leadPmId);
  if (project.clientId) {
    const client = await prisma.clientAccount.findUnique({
      where: { id: project.clientId },
      select: { leadPmId: true, secondaryPmId: true },
    });
    if (client?.leadPmId) ids.add(client.leadPmId);
    if (client?.secondaryPmId) ids.add(client.secondaryPmId);
  }
  let users = ids.size
    ? await prisma.user.findMany({ where: { id: { in: [...ids] }, isActive: true }, select: { id: true, name: true } })
    : [];
  if (users.length === 0) {
    users = await prisma.user.findMany({ where: { role: 'OWNER', isActive: true }, select: { id: true, name: true }, take: 10 });
  }
  return users.map((u) => ({ memberId: u.id, name: String(u.name || 'Agency OS user').slice(0, 200) }));
}

function siteInfoProjectData(siteInfo, contract, now) {
  const health = siteInfo?.health && typeof siteInfo.health === 'object' ? siteInfo.health : {};
  return {
    cmsContractVersion: contract,
    cmsPluginVersion: siteInfo?.plugin?.version ? String(siteInfo.plugin.version).slice(0, 32) : null,
    cmsCapabilities: siteInfo?.capabilities && typeof siteInfo.capabilities === 'object' ? siteInfo.capabilities : {},
    cmsHealth: {
      ...health,
      platform: siteInfo?.platform || null,
      siteUrlReported: siteInfo?.siteUrl ? String(siteInfo.siteUrl).slice(0, 500) : null,
      siteName: siteInfo?.siteName ? String(siteInfo.siteName).slice(0, 200) : null,
      supportedContracts: Array.isArray(siteInfo?.supportedContracts) ? siteInfo.supportedContracts : null,
      receivedAt: now.toISOString(),
    },
    cmsLastSeenAt: now,
    cmsLostNotifiedAt: null,
  };
}

export const prismaCmsStore = {
  async findProjectBySiteId(siteId) {
    return prisma.project.findUnique({ where: { cmsSiteId: siteId }, select: PROJECT_CMS_SELECT });
  },

  async getCredential(projectId) {
    return prisma.cmsCredential.findUnique({ where: { projectId } });
  },

  /** Usable pairing code for a site: not used, not burned, not expired, signing key present. */
  async getActivePairingCode(siteId, now = new Date()) {
    return prisma.cmsPairingCode.findFirst({
      where: { siteId, usedAt: null, burnedAt: null, signingKeyEnc: { not: null }, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
  },

  decryptSigningKey(code) {
    return decryptCmsSecret(code.signingKeyEnc);
  },

  /** Count one failed pairing attempt; burn the code (delete the signing key) at 5. */
  async recordPairingFailure(codeId) {
    await prisma.cmsPairingCode.updateMany({
      where: { id: codeId, usedAt: null, burnedAt: null },
      data: { failedAttempts: { increment: 1 } },
    });
    const row = await prisma.cmsPairingCode.findUnique({ where: { id: codeId }, select: { failedAttempts: true, burnedAt: true } });
    const attempts = row?.failedAttempts ?? PAIRING_MAX_FAILED_ATTEMPTS;
    if (attempts >= PAIRING_MAX_FAILED_ATTEMPTS && !row?.burnedAt) {
      await prisma.cmsPairingCode.updateMany({
        where: { id: codeId, burnedAt: null },
        data: { burnedAt: new Date(), signingKeyEnc: null },
      });
    }
    return { attemptsLeft: Math.max(0, PAIRING_MAX_FAILED_ATTEMPTS - attempts) };
  },

  /** Single use: CAS on usedAt; deletes the signing key (the verifier stays for audit). */
  async consumePairingCode(codeId, now = new Date()) {
    const r = await prisma.cmsPairingCode.updateMany({
      where: { id: codeId, usedAt: null, burnedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now, signingKeyEnc: null },
    });
    return r.count === 1;
  },

  async completePairing({ projectId, siteInfo, contract, inbound, outbound, now = new Date() }) {
    const inboundKeyEnc = encryptCmsSecret(inbound);
    const outboundKeyEnc = encryptCmsSecret(outbound);
    const cred = {
      keyId: 1,
      inboundKeyEnc,
      outboundKeyEnc,
      prevKeyId: null,
      inboundKeyPrevEnc: null,
      outboundKeyPrevEnc: null,
      prevExpiresAt: null,
      pendingKeyId: null,
      inboundKeyPendingEnc: null,
      outboundKeyPendingEnc: null,
      pendingCreatedAt: null,
      rotatedAt: null,
    };
    await prisma.$transaction([
      prisma.cmsCredential.upsert({ where: { projectId }, update: cred, create: { projectId, ...cred } }),
      prisma.project.update({
        where: { id: projectId },
        data: { ...siteInfoProjectData(siteInfo, contract, now), cmsKeyId: 1, cmsPairedAt: now },
      }),
    ]);
  },

  async recordHeartbeat({ projectId, siteInfo, contract, now = new Date() }) {
    await prisma.project.update({ where: { id: projectId }, data: siteInfoProjectData(siteInfo, contract, now) });
  },

  /**
   * Promote the staged key pair: current → prev (valid 24 h), pending → current.
   * CAS on (keyId, pendingKeyId) so two concurrent heartbeats rotate once.
   */
  async applyRotation({ projectId, fromKeyId, now = new Date() }) {
    const cred = await prisma.cmsCredential.findUnique({ where: { projectId } });
    if (!cred || cred.keyId !== fromKeyId || cred.pendingKeyId == null) return null;
    const r = await prisma.cmsCredential.updateMany({
      where: { projectId, keyId: fromKeyId, pendingKeyId: cred.pendingKeyId },
      data: {
        prevKeyId: cred.keyId,
        inboundKeyPrevEnc: cred.inboundKeyEnc,
        outboundKeyPrevEnc: cred.outboundKeyEnc,
        prevExpiresAt: new Date(now.getTime() + KEY_ROTATION_OVERLAP_SEC * 1000),
        keyId: cred.pendingKeyId,
        inboundKeyEnc: cred.inboundKeyPendingEnc,
        outboundKeyEnc: cred.outboundKeyPendingEnc,
        pendingKeyId: null,
        inboundKeyPendingEnc: null,
        outboundKeyPendingEnc: null,
        pendingCreatedAt: null,
        rotatedAt: now,
      },
    });
    if (r.count !== 1) return null;
    await prisma.project.update({ where: { id: projectId }, data: { cmsKeyId: cred.pendingKeyId } });
    return {
      keyId: cred.pendingKeyId,
      inbound: decryptCmsSecret(cred.inboundKeyPendingEnc),
      outbound: decryptCmsSecret(cred.outboundKeyPendingEnc),
    };
  },

  nonceCache: {
    async checkAndStore(key, expiresAtMs) {
      const i = key.indexOf(':');
      const siteId = key.slice(0, i);
      const nonce = key.slice(i + 1);
      const expiresAt = new Date(expiresAtMs);
      try {
        await prisma.cmsNonce.create({ data: { siteId, nonce, expiresAt } });
        if (Math.random() < 0.02) {
          prisma.cmsNonce.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {});
        }
        return true;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Same nonce seen before: fresh only if the old row already expired (CAS).
        const r = await prisma.cmsNonce.updateMany({
          where: { siteId, nonce, expiresAt: { lt: new Date() } },
          data: { expiresAt },
        });
        return r.count === 1;
      }
    },
  },

  /** Claim an eventId for processing. 'new' | 'duplicate'. */
  async claimReceipt(projectId, ev) {
    const data = {
      projectId,
      eventId: String(ev.eventId),
      type: String(ev.type).slice(0, 64),
      cursor: Number.isInteger(ev.cursor) ? ev.cursor : null,
      seq: Number.isInteger(ev.seq) ? ev.seq : null,
      cmsReviewId: ev.review?.reviewId ? String(ev.review.reviewId).slice(0, 64) : null,
      outcome: 'pending',
    };
    try {
      await prisma.cmsEventReceipt.create({ data });
      return 'new';
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const r = await prisma.cmsEventReceipt.updateMany({
        where: {
          projectId,
          eventId: data.eventId,
          outcome: 'pending',
          receivedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) },
        },
        data: { receivedAt: new Date() },
      });
      return r.count === 1 ? 'new' : 'duplicate';
    }
  },

  async finalizeReceipt(projectId, eventId, outcome) {
    await prisma.cmsEventReceipt.updateMany({ where: { projectId, eventId }, data: { outcome } });
  },

  async releaseReceipt(projectId, eventId) {
    await prisma.cmsEventReceipt.deleteMany({ where: { projectId, eventId, outcome: 'pending' } });
  },

  async getReviewSeq(projectId, cmsReviewId, reviewNo) {
    const row = await prisma.wpContentReview.findFirst({
      where: {
        projectId,
        OR: [{ cmsReviewId }, ...(Number.isInteger(reviewNo) ? [{ wpPipelineId: reviewNo }] : [])],
      },
      select: { cmsSeq: true },
    });
    return row?.cmsSeq ?? 0;
  },

  async getEntryUpdatedAt(projectId, cmsEntryId, entryNo) {
    const row = await prisma.wpPage.findFirst({
      where: {
        projectId,
        OR: [{ cmsEntryId }, ...(Number.isInteger(entryNo) ? [{ wpPostId: entryNo }] : [])],
      },
      select: { modifiedAt: true },
    });
    return row?.modifiedAt || null;
  },

  async setLastCursor(projectId, cursor) {
    if (!Number.isInteger(cursor) || cursor <= 0) return;
    await prisma.project.updateMany({
      where: { id: projectId, OR: [{ cmsLastCursor: null }, { cmsLastCursor: { lt: cursor } }] },
      data: { cmsLastCursor: cursor },
    });
  },

  async touchLastSeen(projectId, now = new Date()) {
    await prisma.project.updateMany({ where: { id: projectId }, data: { cmsLastSeenAt: now, cmsLostNotifiedAt: null } });
  },

  isTombstoned(projectId, reviewNo) {
    return isPipelineTombstoned(projectId, reviewNo);
  },

  listPms,

  async applyPipelineEvent(project, normalized, log) {
    return applyReviewEvent({ project, event: normalized, log });
  },

  async applyContentEvent(project, ev) {
    return applyEmdashContentEvent(project, ev);
  },

  afterContentBatch(projectId, log) {
    reconcileProjectMapsSafe(projectId, log);
  },
};

/** content.* event → WpPage (+ WpPageSnapshot when the content hash changed). No AI summary (cost). */
export async function applyEmdashContentEvent(project, ev) {
  const { wpPostId, data } = entryToPageData(ev.entry, project.wpUrl);
  if (!wpPostId) throw new CmsBridgeError({ status: 400, code: 'VALIDATION', message: 'entry.entryNo is required' });
  const now = new Date();
  const existing = await prisma.wpPage.findUnique({
    where: { projectId_wpPostId: { projectId: project.id, wpPostId } },
    select: { id: true, title: true, contentHash: true, content: true },
  });
  const actor = ev.actor || {};
  const who = {
    wpUserId: actor.osUserId || actor.id ? String(actor.osUserId || actor.id).slice(0, 255) : null,
    wpUserName: actor.name ? String(actor.name).slice(0, 255) : null,
  };

  if (ev.type === 'content.deleted') {
    if (existing) {
      await prisma.wpPage.update({ where: { id: existing.id }, data: { status: 'deleted', syncedAt: now } });
      await prisma.wpPageSnapshot.create({
        data: {
          wpPageId: existing.id,
          title: existing.title,
          content: '',
          status: 'deleted',
          contentHash: String(Date.now()),
          eventType: 'deleted',
          ...who,
          isElementor: false,
          syncedAt: now,
        },
      });
    }
    return 'applied';
  }

  const content = typeof ev.snapshotText === 'string' ? ev.snapshotText.slice(0, 100_000) : undefined;
  const revisionId = data.cmsDraftRevisionId || data.cmsLiveRevisionId || null;
  if (!existing) {
    const page = await prisma.wpPage.create({
      data: { projectId: project.id, wpPostId, ...data, content: content ?? '', syncedAt: now },
    });
    await prisma.wpPageSnapshot.create({
      data: {
        wpPageId: page.id,
        title: data.title,
        content: content ?? '',
        status: data.status,
        seoTitle: data.seoTitle,
        seoDescription: data.seoDescription,
        contentHash: data.contentHash,
        eventType: 'created',
        contentExcerpt: data.excerpt,
        ...who,
        isElementor: false,
        cmsRevisionId: revisionId,
        syncedAt: now,
      },
    });
    return 'applied';
  }

  await prisma.wpPage.update({
    where: { id: existing.id },
    data: { ...data, ...(content !== undefined ? { content } : {}), syncedAt: now },
  });
  if (existing.contentHash !== data.contentHash) {
    await prisma.wpPageSnapshot.create({
      data: {
        wpPageId: existing.id,
        title: data.title,
        content: content ?? existing.content ?? '',
        status: data.status,
        seoTitle: data.seoTitle,
        seoDescription: data.seoDescription,
        contentHash: data.contentHash,
        eventType: 'updated',
        contentExcerpt: data.excerpt,
        ...who,
        isElementor: false,
        cmsRevisionId: revisionId,
        syncedAt: now,
      },
    });
  }
  return 'applied';
}

/**
 * Upsert a WpContentReview from a contract Review (pull sync / response mirror / heal).
 * No notifications and no cmsSeq advance (only the event stream advances cmsSeq).
 * Never regresses a published row; never overwrites an OS assignee.
 */
export async function mirrorEmdashReview(projectId, review, { log } = {}) {
  const m = reviewToMirrorData(review);
  if (!m.wpPipelineId) return null;
  if (await isPipelineTombstoned(projectId, m.wpPipelineId)) return null;
  const existing = await prisma.wpContentReview.findUnique({
    where: { projectId_wpPipelineId: { projectId, wpPipelineId: m.wpPipelineId } },
    select: { id: true, isPublished: true, publishedAt: true, assignedWorkerId: true, cmsSeq: true },
  });
  // A response/pull older than what the event stream already applied must not rewind the mirror.
  if (existing && Number.isInteger(m.seq) && Number.isInteger(existing.cmsSeq) && m.seq < existing.cmsSeq) {
    return existing;
  }
  const data = { ...m.data };
  if (existing?.isPublished) {
    data.isPublished = true;
    if (data.status !== 'cancelled') data.status = 'published';
  }
  if (data.isPublished && !existing?.publishedAt) data.publishedAt = new Date();
  const review_ = await prisma.wpContentReview.upsert({
    where: { projectId_wpPipelineId: { projectId, wpPipelineId: m.wpPipelineId } },
    update: data,
    create: {
      projectId,
      wpPipelineId: m.wpPipelineId,
      postTitle: m.postTitle,
      ...data,
      ...(!existing?.assignedWorkerId && data.submittedById
        ? { assignedWorkerId: data.submittedById, assignedWorkerName: data.submittedByName }
        : {}),
    },
  });
  mirrorPipelineToMaps(projectId, review_, log).catch(() => {});
  return review_;
}

/**
 * Fill timeline gaps from a Review's `history` (pipeline-get heal, contract §6.3):
 * create WpContentReviewEvent rows for history seqs the OS has not stored yet.
 */
export async function backfillEmdashHistory(projectId, review) {
  const m = reviewToMirrorData(review);
  if (!m.wpPipelineId || !m.history.length) return 0;
  const row = await prisma.wpContentReview.findUnique({
    where: { projectId_wpPipelineId: { projectId, wpPipelineId: m.wpPipelineId } },
    select: { id: true },
  });
  if (!row) return 0;
  const have = await prisma.wpContentReviewEvent.findMany({
    where: { contentReviewId: row.id, cmsSeq: { not: null } },
    select: { cmsSeq: true },
  });
  const seen = new Set(have.map((h) => h.cmsSeq));
  let created = 0;
  for (const h of m.history) {
    if (!Number.isInteger(h?.seq) || seen.has(h.seq)) continue;
    const type = String(h.type || '').slice(0, 100);
    const comment = h.comment ? String(h.comment).slice(0, 10000) : null;
    let scoped = commentsForEventType(type, {
      workerNote: comment,
      pmComment: comment,
      clientComment: comment,
    });
    // Types without a comment slot (draft_updated, unknown) keep the comment as the log line.
    let message = null;
    if (comment && scoped.workerNote && scoped.pmComment && scoped.clientComment) {
      scoped = { workerNote: null, pmComment: null, clientComment: null };
      message = comment.slice(0, 500);
    }
    const at = h.at ? new Date(h.at) : new Date();
    await prisma.wpContentReviewEvent.create({
      data: {
        contentReviewId: row.id,
        eventType: type,
        status: String(h.status || '').slice(0, 50),
        revisionNumber: Number(h.round) || 1,
        message,
        workerNote: scoped.workerNote,
        pmComment: scoped.pmComment,
        clientComment: scoped.clientComment,
        cmsSeq: h.seq,
        createdAt: Number.isNaN(at.getTime()) ? new Date() : at,
      },
    });
    seen.add(h.seq);
    created += 1;
  }
  return created;
}
