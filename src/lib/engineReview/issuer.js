/**
 * SEO Engine exact-result review issuer (OS-11/12), adapted from the Engine's `localwaves-review` bundle
 * (issuer.mjs). Behaviour is kept; changes for this repo:
 *   - readable formatting, `{ message, code }` errors (EngineReviewError → route maps to the HTTP status);
 *   - several allowed browser origins (FRONTEND_URL may be a comma list);
 *   - agents are never reviewers: the reviewer map is validated against the DB at load (isAgent / inactive / role
 *     mismatch → issuer disabled) and every request re-checks `request.user.isAgent` and refuses API tokens;
 *   - outbox rows also carry osProjectId and the signed event's expiresAt (pull-only delivery, OS-13).
 *
 * Flow: freeze a pinned Engine reporter's persisted comment → show it (exact text + result hash) → reviewer creates a
 * 120 s single-use challenge for one decision → confirms with the challenge hash → transactional consume/CAS/outbox
 * insert → Ed25519-signed envelope {keyId, event, signature}. Nothing here publishes, completes the OS task, notifies
 * anyone or touches a site or Google.
 */
import { createHash, createPrivateKey, randomUUID, sign } from 'crypto';

export class EngineReviewError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const fail = (code, message, status = 400) => {
  throw new EngineReviewError(code, message, status);
};

/** Canonical JSON (object keys sorted recursively). Must match the Engine's verifier. */
export const canonical = (value) =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
      : v
  );
export const hash = (value) => createHash('sha256').update(canonical(value)).digest('hex');

const text = (value, max = 200) => typeof value === 'string' && value.trim() !== '' && value.length <= max;

function exact(value, fields) {
  if (
    !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((k) => !fields.includes(k))
    || fields.some((k) => !Object.hasOwn(value, k))
  ) {
    fail('INVALID_ARGUMENTS', 'Unexpected or missing review fields.');
  }
}

const REVIEWER_ROLES = ['OWNER', 'PM'];

/**
 * Validates the reviewer map against the users table (config load, OS-12). Throws EngineReviewError when any entry
 * is malformed, unknown, inactive, an agent account, has a different role, or is also a pinned Engine reporter.
 */
export async function validateReviewerMap(prisma, reviewers, reporterUserIds) {
  if (!Array.isArray(reviewers) || reviewers.length === 0) fail('REVIEW_ISSUER_CONFIG', 'Reviewer map is empty.', 503);
  for (const r of reviewers) {
    if (!r || !text(r.osUserId) || !text(r.engineActorId) || !REVIEWER_ROLES.includes(r.role)) {
      fail('REVIEW_ISSUER_CONFIG', 'Reviewer map entries need {osUserId, engineActorId, role: OWNER|PM}.', 503);
    }
    if (reporterUserIds.includes(r.osUserId)) {
      fail('REVIEW_ISSUER_CONFIG', 'A pinned Engine reporter account cannot also be a reviewer.', 503);
    }
  }
  const ids = [...new Set(reviewers.map((r) => r.osUserId))];
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, role: true, isActive: true, isAgent: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  for (const r of reviewers) {
    const u = byId.get(r.osUserId);
    if (!u || !u.isActive) fail('REVIEW_ISSUER_CONFIG', `Reviewer ${r.osUserId} is not an active OS user.`, 503);
    if (u.isAgent) fail('REVIEW_ISSUER_CONFIG', `Reviewer ${r.osUserId} is an agent account; agents can never review.`, 503);
    if (u.role !== r.role) fail('REVIEW_ISSUER_CONFIG', `Reviewer ${r.osUserId} role does not match the OS user role.`, 503);
  }
}

export function createOsReviewIssuer({ prisma, store, config, now = () => new Date().toISOString() } = {}) {
  if (!prisma?.task?.findUnique || !prisma?.taskComment?.findUnique || !store?.transaction) {
    fail('REVIEW_ISSUER_DISABLED', 'Prisma and a durable transactional review store are required.', 503);
  }
  const origins = Array.isArray(config?.origins) ? config.origins.filter((o) => text(o, 500)) : [];
  if (
    !config || !text(config.tenantId) || !text(config.issuer) || !text(config.keyId) || origins.length === 0
    || !Array.isArray(config.reporterUserIds) || !config.reporterUserIds.length
    || !Array.isArray(config.reviewers) || !config.reviewers.length
  ) {
    fail('REVIEW_ISSUER_CONFIG', 'Pinned issuer, reporter and reviewer configuration is required.', 503);
  }
  let key;
  try {
    key = createPrivateKey(config.privateKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
  } catch {
    fail('REVIEW_ISSUER_CONFIG', 'An OS-only Ed25519 private key is required.', 503);
  }

  function timestamp() {
    const value = Date.parse(now());
    if (!Number.isFinite(value)) fail('INVALID_CLOCK', 'Invalid issuer clock.', 500);
    return value;
  }

  function assertHumanReviewer(user) {
    if (!user || !REVIEWER_ROLES.includes(user.role) || !text(user.id)) {
      fail('FORBIDDEN', 'Active OS OWNER or project PM is required.', 403);
    }
    if (user.isAgent === true) fail('REVIEW_AGENT_FORBIDDEN', 'Agent accounts can never review.', 403);
  }

  async function taskAccess(taskId, user) {
    assertHumanReviewer(user);
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: { project: { include: { client: true } }, assignees: { select: { id: true } } },
    });
    if (!task) fail('NOT_FOUND', 'Task not found.', 404);
    const p = task.project;
    if (user.role !== 'OWNER' && ![p.leadPmId, p.client?.leadPmId, p.client?.secondaryPmId].includes(user.id)) {
      fail('FORBIDDEN', 'Reviewer is not a PM of this project.', 403);
    }
    if (['COMPLETED', 'CANCELLED'].includes(task.status)) {
      fail('OS_TASK_TERMINAL', 'Terminal OS task requires reconciliation.', 409);
    }
    return task;
  }

  function identity(user, task, snapshot) {
    assertHumanReviewer(user);
    const reviewer = config.reviewers.find((r) => r.osUserId === user.id && r.role === user.role);
    if (!reviewer || !text(reviewer.engineActorId)) {
      fail('REVIEW_IDENTITY_UNTRUSTED', 'OS reviewer needs a pinned Engine identity mapping.', 403);
    }
    if (
      task.assignees.some((a) => a.id === user.id)
      || [snapshot.report.workerId, snapshot.report.authorId].includes(reviewer.engineActorId)
    ) {
      fail('REVIEW_SELF_APPROVAL', 'Result author and task assignees cannot review their own result.', 403);
    }
    return reviewer;
  }

  async function freeze(taskId, args, user) {
    exact(args, ['commentId']);
    if (!text(args.commentId)) fail('INVALID_ARGUMENTS', 'Comment identity is required.');
    const task = await taskAccess(taskId, user);
    const comment = await prisma.taskComment.findUnique({ where: { id: args.commentId } });
    if (!comment || comment.taskId !== taskId || !config.reporterUserIds.includes(comment.userId)) {
      fail('REPORT_NOT_TRUSTED', 'A persisted report from the pinned Engine reporter is required.', 403);
    }
    const content = comment.content;
    if (typeof content !== 'string' || content.length > 10000) {
      fail('REPORT_NOT_TRUSTED', 'Bounded persisted Engine report is required.', 409);
    }
    const first = content.indexOf('\n');
    const last = content.lastIndexOf('\n\n[seo-engine-result:');
    let report;
    try {
      if (!content.slice(0, first).startsWith('SEO Engine worker result') || last < first) throw new Error('shape');
      report = JSON.parse(content.slice(first + 1, last));
    } catch {
      fail('REPORT_NOT_TRUSTED', 'Report does not match the Engine report contract.', 409);
    }
    if (!report || typeof report !== 'object') fail('REPORT_NOT_TRUSTED', 'Report does not match the Engine report contract.', 409);
    for (const field of ['engineProjectId', 'engineTaskId', 'resultId', 'workerId', 'authorId']) {
      if (!text(report[field])) fail('REPORT_NOT_TRUSTED', 'Report result binding is incomplete.', 409);
    }
    if (
      !/^[a-f0-9]{64}$/.test(report.resultHash) || !Number.isSafeInteger(report.reviewVersion)
      || report.reviewVersion < 0 || report.publicationAuthorized !== false
    ) {
      fail('REPORT_NOT_TRUSTED', 'Exact result hash, review version and publication denial are required.', 409);
    }
    const snapshot = {
      id: randomUUID(), taskId, osProjectId: task.projectId, commentId: comment.id, reportHash: hash(content),
      report, content, createdAt: new Date(timestamp()).toISOString(),
    };
    identity(user, task, snapshot);
    return store.transaction(async (tx) => {
      const prior = await tx.snapshotByComment(comment.id);
      if (prior) {
        if (prior.reportHash !== snapshot.reportHash) {
          fail('REPORT_CHANGED', 'The original frozen report was edited; preserve its old snapshot and reconcile.', 409);
        }
        return prior;
      }
      const head = await tx.head(taskId);
      if (head && (head.version !== report.reviewVersion || !['revision_needed', 'queued'].includes(head.state))) {
        fail('REVIEW_VERSION_CONFLICT', 'OS review head does not permit a new result at this version.', 409);
      }
      await tx.createSnapshot(snapshot);
      if (head) {
        const ok = await tx.advanceHead(taskId, head, { resultId: report.resultId, version: report.reviewVersion, state: 'needs_review' });
        if (!ok) fail('REVIEW_VERSION_CONFLICT', 'Concurrent review changed the task.', 409);
      } else {
        await tx.createHead({ taskId, resultId: report.resultId, version: report.reviewVersion, state: 'needs_review' });
      }
      return snapshot;
    });
  }

  async function view(taskId, snapshotId, user) {
    const task = await taskAccess(taskId, user);
    const snapshot = await store.transaction((tx) => tx.snapshot(snapshotId));
    if (!snapshot || snapshot.taskId !== taskId || snapshot.osProjectId !== task.projectId) {
      fail('NOT_FOUND', 'Frozen result not found in this task.', 404);
    }
    identity(user, task, snapshot);
    return {
      ...snapshot,
      displayRequirement: 'Display this frozen content, result ID and exact result hash before requesting interactive confirmation.',
      publicationAuthorized: false,
      osCompletionAuthorized: false,
    };
  }

  async function challenge(taskId, args, user) {
    exact(args, ['snapshotId', 'operation', 'decision', 'reason']);
    const validDecision = args.operation === 'task_review'
      ? ['revision_needed', 'approved', 'rejected'].includes(args.decision)
      : args.decision === 'queued';
    if (!text(args.snapshotId) || !['task_review', 'task_reopen'].includes(args.operation) || !text(args.reason, 10000) || !validDecision) {
      fail('INVALID_ARGUMENTS', 'Exact review operation, decision and reason are required.');
    }
    const snapshot = await view(taskId, args.snapshotId, user);
    const issued = timestamp();
    return store.transaction(async (tx) => {
      const head = await tx.head(taskId);
      const expectedState = args.operation === 'task_review' ? 'needs_review' : 'revision_needed';
      if (!head || head.resultId !== snapshot.report.resultId || head.state !== expectedState) {
        fail('REVIEW_VERSION_CONFLICT', 'Frozen result is no longer the current review state.', 409);
      }
      const value = {
        id: randomUUID(), taskId, snapshotId: snapshot.id, userId: user.id, operation: args.operation,
        decision: args.decision, reason: args.reason, expectedReviewVersion: head.version,
        reportHash: snapshot.reportHash, resultHash: snapshot.report.resultHash,
        issuedAt: new Date(issued).toISOString(), expiresAt: new Date(issued + 120000).toISOString(),
      };
      value.challengeHash = hash(value);
      await tx.createChallenge(value);
      return {
        ...value,
        confirmationRequirement: 'Display the frozen result and submit an explicit authenticated OS operator action bound to challengeHash. This is an operator assertion, not proof of human presence.',
      };
    });
  }

  async function confirm(taskId, args, user, request) {
    exact(args, ['challengeId', 'confirmation']);
    if (!text(args.challengeId)) fail('INVALID_ARGUMENTS', 'Challenge identity is required.');
    if (!origins.includes(request?.headers?.origin)) {
      fail('FORBIDDEN', 'Review confirmation requires the configured OS browser origin.', 403);
    }
    const task = await taskAccess(taskId, user);
    const value = await store.transaction((tx) => tx.challenge(args.challengeId));
    if (!value || value.taskId !== taskId || value.userId !== user.id) fail('NOT_FOUND', 'Review challenge not found.', 404);
    const snapshot = await view(taskId, value.snapshotId, user);
    const reviewer = identity(user, task, snapshot);
    const existing = await store.transaction((tx) => tx.outboxByChallenge(value.id));
    if (existing) return existing;
    if (Date.parse(value.expiresAt) <= timestamp() || value.reportHash !== snapshot.reportHash || value.resultHash !== snapshot.report.resultHash) {
      fail('REVIEW_EXPIRED', 'Review challenge expired or result changed.', 409);
    }
    if (args.confirmation !== value.challengeHash) {
      fail('REVIEW_CONFIRMATION_REQUIRED', 'Explicit confirmation must bind the exact frozen result and decision challenge.', 409);
    }
    const issued = timestamp();
    const event = {
      schemaVersion: 1,
      contract: 'localwaves.engine.review.v1',
      issuer: config.issuer,
      eventId: randomUUID(),
      tenantId: config.tenantId,
      projectId: snapshot.report.engineProjectId,
      osProjectId: task.projectId,
      taskId: snapshot.report.engineTaskId,
      osTaskId: taskId,
      resultId: snapshot.report.resultId,
      resultHash: value.resultHash,
      operation: value.operation,
      decision: value.decision,
      expectedReviewVersion: value.expectedReviewVersion,
      reason: value.reason,
      issuedAt: new Date(issued).toISOString(),
      expiresAt: new Date(issued + 900000).toISOString(),
      reviewer: { osUserId: user.id, engineActorId: reviewer.engineActorId, role: user.role, authentication: 'authenticated_os_session' },
    };
    const envelope = { keyId: config.keyId, event, signature: sign(null, Buffer.from(canonical(event)), key).toString('base64url') };
    return store.transaction(async (tx) => {
      const old = await tx.outboxByChallenge(value.id);
      if (old) return old;
      if (Date.parse(value.expiresAt) <= timestamp()) {
        fail('REVIEW_EXPIRED', 'Review challenge expired before transactional confirmation.', 409);
      }
      if (!(await tx.consumeChallenge(value.id, user.id))) fail('REVIEW_REPLAY_CONFLICT', 'Challenge was already consumed.', 409);
      const fromState = event.operation === 'task_review' ? 'needs_review' : 'revision_needed';
      const advanced = await tx.advanceHead(
        taskId,
        { resultId: event.resultId, version: event.expectedReviewVersion, state: fromState },
        { resultId: event.resultId, version: event.expectedReviewVersion + 1, state: event.decision }
      );
      if (!advanced) fail('REVIEW_VERSION_CONFLICT', 'Review changed during interactive confirmation.', 409);
      await tx.createOutbox({
        challengeId: value.id, eventId: event.eventId, taskId, osProjectId: task.projectId, resultId: event.resultId,
        version: event.expectedReviewVersion, expiresAt: event.expiresAt, envelope,
      });
      return envelope;
    });
  }

  return { freeze, view, challenge, confirm, origins, reporterUserIds: [...config.reporterUserIds] };
}
