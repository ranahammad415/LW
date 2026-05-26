import { prisma } from './prisma.js';
import { sendEmail } from './mailer.js';
import { deferEmail } from './emailDeferralQueue.js';
import { wrapInBrandedLayout } from './emailLayout.js';
import { actionHeader, ctaButton, commentBlock, taskDetailCard, issueDetailCard, commentThread } from './emailComponents.js';
import { enrichTaskData, enrichRecentComments, enrichIssueData, enrichIssueComments } from './emailDataEnricher.js';

/**
 * Replace {{key}} placeholders in a template string with values from the variables object.
 */
function renderTemplate(template, variables = {}) {
  if (!template) return '';
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return variables[key] !== undefined ? String(variables[key]) : `{{${key}}}`;
  });
}

/**
 * Decide whether a given NotificationTemplate allows emailing a given user,
 * based on the template's per-role email flags and the user's role.
 *
 * Rules:
 *   - OWNER                              -> emailAgencyOwner
 *   - PM / TEAM_MEMBER / CONTRACTOR      -> emailPm
 *   - CLIENT with ClientUser.role VIEWER -> emailClientViewer
 *   - CLIENT otherwise (default MANAGER) -> emailClientManager
 *   - Unknown role                       -> allowed (fail-open)
 *
 * Each flag is compared with `!== false`, so missing/undefined flags
 * (e.g., when the Prisma client has not yet been regenerated) default to allowed.
 *
 * Exported so it can be unit-tested and reused.
 */
export function templateAllowsEmailForUser(template, user) {
  if (!template || !user) return true;
  switch (user.role) {
    case 'OWNER':
      return template.emailAgencyOwner !== false;
    case 'PM':
    case 'TEAM_MEMBER':
    case 'CONTRACTOR':
      return template.emailPm !== false;
    case 'CLIENT': {
      const access = Array.isArray(user.clientAccess) ? user.clientAccess[0] : null;
      const isViewer = access && String(access.role).toUpperCase() === 'VIEWER';
      return isViewer
        ? template.emailClientViewer !== false
        : template.emailClientManager !== false;
    }
    default:
      return true;
  }
}

/**
 * Resolve the notification audience for a given user.
 *
 *   OWNER                               -> AGENCY_OWNER
 *   PM / TEAM_MEMBER / CONTRACTOR       -> AGENCY_TEAM
 *   CLIENT with ClientUser.role VIEWER  -> CLIENT_VIEWER
 *   CLIENT otherwise (default MANAGER)  -> CLIENT_MANAGER
 *   Unknown / null                      -> AGENCY_TEAM (safe default)
 *
 * Exported for unit testing and reuse in the admin API (test-send).
 */
export function audienceForUser(user) {
  if (!user) return 'AGENCY_TEAM';
  switch (user.role) {
    case 'OWNER':
      return 'AGENCY_OWNER';
    case 'PM':
    case 'TEAM_MEMBER':
    case 'CONTRACTOR':
      return 'AGENCY_TEAM';
    case 'CLIENT': {
      const access = Array.isArray(user.clientAccess) ? user.clientAccess[0] : null;
      const isViewer = access && String(access.role).toUpperCase() === 'VIEWER';
      return isViewer ? 'CLIENT_VIEWER' : 'CLIENT_MANAGER';
    }
    default:
      return 'AGENCY_TEAM';
  }
}

/**
 * Pick a per-audience variant, or fall back to the base template's copy.
 * Returns an object exposing the exact fields a renderer needs:
 *   { subject, bodyHtml, bodyText, inAppMessage, ctaLabel }
 *
 * Exported for unit testing.
 */
export function resolveVariantForAudience(variantsByAudience, audience, baseTemplate) {
  const variant = variantsByAudience && variantsByAudience[audience];
  if (variant) {
    return {
      subject: variant.subject || baseTemplate.subject,
      bodyHtml: variant.bodyHtml || baseTemplate.bodyHtml,
      bodyText: variant.bodyText != null ? variant.bodyText : baseTemplate.bodyText,
      inAppMessage: variant.inAppMessage || baseTemplate.inAppMessage,
      ctaLabel: variant.ctaLabel || null,
      source: 'variant',
      audience,
    };
  }
  return {
    subject: baseTemplate.subject,
    bodyHtml: baseTemplate.bodyHtml,
    bodyText: baseTemplate.bodyText,
    inAppMessage: baseTemplate.inAppMessage,
    ctaLabel: null,
    source: 'base',
    audience,
  };
}

// ── Slug-to-action-text mapping for the action header ──────────────────────
const ACTION_TEXT_MAP = {
  task_created:              'created a task',
  task_assigned:             'assigned a task to you',
  task_unassigned:           'removed you from a task',
  task_status_changed:       'changed task status',
  task_completed:            'marked a task complete',
  task_overdue:              'flagged a task as overdue',
  task_stagnant:             'flagged a task as stagnant',
  task_comment_added:        'added a comment',
  task_deliverable_uploaded: 'uploaded a deliverable',
  user_mentioned_in_task:    'mentioned you',
  user_mentioned_in_issue:   'mentioned you',
  issue_created:             'reported an issue',
  issue_assigned:            'assigned an issue to you',
  issue_status_changed:      'changed issue status',
  issue_comment_added:       'added a comment',
  issue_resolved:            'resolved an issue',
  content_submitted_for_review:    'submitted content for review',
  content_pm_approved:             'approved content',
  content_pm_changes_requested:    'requested changes',
  content_client_approved:         'approved content',
  content_client_changes_requested:'requested changes',
  content_ready_for_client_review: 'sent content for your review',
  content_published:               'published content',
  project_created:           'created a project',
  client_input_requested:    'requested your input',
  client_input_fulfilled:    'provided input',
  keyword_suggestion_approved:  'approved a keyword',
  keyword_suggestion_rejected:  'rejected a keyword',
  meeting_scheduled:         'scheduled a meeting',
};

// CTA label mapping
const CTA_LABEL_MAP = {
  task:         'View task',
  pipeline:     'Review content',
  issue:        'View issue',
  client:       'View details',
  client_input: 'Respond now',
  keyword:      'View keywords',
  project:      'View project',
  meeting:      'View meeting',
  report:       'View report',
  standup:      'View standup',
};

// Slugs that should show a task detail card
const TASK_CARD_SLUGS = new Set([
  'task_created', 'task_assigned', 'task_unassigned', 'task_status_changed',
  'task_completed', 'task_overdue', 'task_stagnant', 'task_comment_added',
  'task_deliverable_uploaded', 'user_mentioned_in_task',
  'client_input_requested', 'client_input_fulfilled',
]);

// Slugs that should show a comment thread
const COMMENT_THREAD_SLUGS = new Set([
  'task_comment_added', 'user_mentioned_in_task',
]);

// Slugs that should show an issue detail card
const ISSUE_CARD_SLUGS = new Set([
  'issue_created', 'issue_assigned', 'issue_status_changed',
  'issue_comment_added', 'issue_resolved', 'user_mentioned_in_issue',
]);

// Slugs that should show issue comment thread
const ISSUE_COMMENT_SLUGS = new Set([
  'issue_comment_added', 'user_mentioned_in_issue',
]);

/**
 * Pre-enrich shared context for a notification send.
 *
 * The detail card and comment thread do NOT depend on the recipient's
 * audience, so we compute them once and reuse for every recipient to
 * avoid re-querying the database per user.
 *
 * Returns `{ detailCardHtml, commentThreadHtml, commentPreview, actorName,
 *            actionText, projectName }`.
 */
async function buildSharedEmailContext(slug, variables, metadata) {
  const actorName = variables.authorName || variables.assignedBy || variables.changedBy ||
                    variables.completedBy || variables.uploadedBy || variables.submittedBy ||
                    variables.senderName || variables.memberName || 'Localwaves';
  const actionText = ACTION_TEXT_MAP[slug] || '';
  const projectName = variables.projectName || '';
  const commentPreview = variables.commentPreview || variables.requestNote || variables.messagePreview || '';

  let detailCardHtml = '';
  let commentThreadHtml = '';

  const taskId = metadata?.taskId;
  const issueId = metadata?.issueId;

  try {
    if (taskId && TASK_CARD_SLUGS.has(slug)) {
      const taskData = await enrichTaskData(taskId);
      if (taskData) detailCardHtml = taskDetailCard(taskData);
    } else if (issueId && ISSUE_CARD_SLUGS.has(slug)) {
      const issueData = await enrichIssueData(issueId);
      if (issueData) detailCardHtml = issueDetailCard(issueData);
    }

    if (taskId && COMMENT_THREAD_SLUGS.has(slug)) {
      const comments = await enrichRecentComments(taskId, 4);
      if (comments.length > 0) commentThreadHtml = commentThread(comments);
    } else if (issueId && ISSUE_COMMENT_SLUGS.has(slug)) {
      const comments = await enrichIssueComments(issueId, 4);
      if (comments.length > 0) commentThreadHtml = commentThread(comments);
    }
  } catch (err) {
    console.error(`[notify] Enrichment failed for "${slug}":`, err.message);
  }

  return { detailCardHtml, commentThreadHtml, commentPreview, actorName, actionText, projectName };
}

/**
 * Escape a plain string for safe inclusion in HTML.
 */
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build a small italic block to render the AI/content summary in pipeline
 * notifications. Returns '' if no summary is provided.
 */
function buildSummaryBlockHtml(summary) {
  const text = String(summary || '').trim();
  if (!text) return '';
  return (
    '<div style="margin:0 0 12px;padding:10px 14px;background:#f8fafc;border-left:3px solid #6366f1;border-radius:4px;">' +
      '<p style="margin:0;font-size:13px;line-height:1.55;color:#475569;font-style:italic;">' +
        escapeHtml(text) +
      '</p>' +
    '</div>'
  );
}

/**
 * Build rich email HTML for a single recipient using a resolved source
 * (base template or audience variant) and pre-enriched shared context.
 */
async function buildRichEmailHtml(slug, category, source, variables, actionUrl, sharedContext) {
  const { actorName, actionText, projectName, commentPreview, detailCardHtml, commentThreadHtml } = sharedContext;
  const ctaLabel = source.ctaLabel || CTA_LABEL_MAP[category] || 'View in Portal';
  const summaryHtml = buildSummaryBlockHtml(variables.aiSummary);

  // Rendered simple body from the resolved source (fallback content)
  const renderedBodyHtml = renderTemplate(source.bodyHtml, variables);
  const preheader = renderTemplate(source.subject, variables);

  // If no actorName available (system notifications), use simple layout
  if (!actionText) {
    return await wrapInBrandedLayout({
      bodyHtml: renderedBodyHtml,
      preheader,
      actionUrl,
      actionLabel: ctaLabel,
      category,
      summaryHtml,
    });
  }

  const actionHeaderHtml = actionHeader({
    actorName,
    actionText,
    contextLine: projectName ? `Localwaves \u2013 ${projectName}` : 'Localwaves',
  });

  let commentBlockHtml = '';
  if (commentPreview && (slug.includes('comment') || slug.includes('mention'))) {
    commentBlockHtml = commentBlock(actorName, commentPreview);
  }

  return await wrapInBrandedLayout({
    bodyHtml: (!commentBlockHtml && !detailCardHtml && !summaryHtml) ? renderedBodyHtml : '',
    preheader,
    actionUrl,
    actionLabel: ctaLabel,
    category,
    actionHeaderHtml,
    commentBlockHtml,
    summaryHtml,
    detailCardHtml,
    commentThreadHtml,
  });
}

/**
 * Central notification dispatcher.
 *
 * Features:
 * - Multi-channel delivery (email + in-app)
 * - Smart email deferral: if the user has in-app enabled, the email is deferred
 *   by ~3 minutes. If the user reads the in-app notification before then, the
 *   email is skipped entirely.
 * - Rich Asana-style branded email layout with task cards, comment threads, avatars.
 *
 * @param {object} opts
 * @param {string}   opts.slug          - NotificationTemplate slug
 * @param {string[]} opts.recipientIds  - Array of User IDs to notify
 * @param {object}   [opts.variables]   - Template variable values
 * @param {string}   [opts.actionUrl]   - In-app link for the notification
 * @param {object}   [opts.metadata]    - Extra JSON (taskId, projectId, issueId, etc.)
 */
export async function notify({ slug, recipientIds, variables = {}, actionUrl = null, metadata = null }) {
  if (!recipientIds || recipientIds.length === 0) return;

  const uniqueIds = [...new Set(recipientIds.filter(Boolean))];
  if (uniqueIds.length === 0) return;

  // 1. Fetch template
  let template;
  try {
    template = await prisma.notificationTemplate.findUnique({ where: { slug } });
  } catch (err) {
    console.error(`[notify] Failed to fetch template "${slug}":`, err.message);
    return;
  }
  if (!template || !template.isActive) return;

  // 1b. Fetch per-audience variants for this template (if the new table exists)
  const variantsByAudience = {};
  try {
    const variants = await prisma.notificationTemplateVariant.findMany({
      where: { templateSlug: slug },
    });
    for (const v of variants) variantsByAudience[v.audience] = v;
  } catch (err) {
    // Table may not exist yet if the Prisma client hasn't been regenerated.
    // Fail-open: everyone gets the base template copy.
    console.warn(`[notify] Variant fetch skipped for "${slug}":`, err.message);
  }

  // 2. Fetch recipients + preferences
  const recipients = await prisma.user.findMany({
    where: { id: { in: uniqueIds }, isActive: true },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      clientAccess: {
        select: { role: true },
        take: 1,
      },
      notificationPreferences: {
        where: { templateSlug: slug },
        select: { emailEnabled: true, inAppEnabled: true },
      },
    },
  });

  const roleAllowsEmail = (user) => templateAllowsEmailForUser(template, user);

  // 3. Resolve actionUrl to full URL if it's a relative path
  const fullActionUrl = actionUrl
    ? (actionUrl.startsWith('http') ? actionUrl : `${process.env.FRONTEND_URL || 'https://app.localwaves.ai'}${actionUrl}`)
    : null;

  // Helper: rewrite a portal project URL path to match the recipient's role.
  // Webhooks pass `/portal/admin/projects/{id}` as a stable fallback; this
  // function swaps the role segment so PMs / clients land on a page they can
  // actually access (avoids /unauthorized 404). Project ID is read from
  // metadata.projectId. Other URLs (full external, non-project paths) pass
  // through unchanged.
  const rewritePortalUrlForUser = (url, user) => {
    if (!url) return url;
    const projectId = metadata?.projectId;
    if (!projectId) return url;
    const role = String(user.role || '').toUpperCase();
    let rolePath;
    if (role === 'OWNER') rolePath = 'admin';
    else if (role === 'CLIENT') rolePath = 'client';
    else rolePath = 'pm'; // PM, TEAM_MEMBER, CONTRACTOR
    const targetPath = `/portal/${rolePath}/projects/${projectId}`;
    try {
      const u = new URL(url);
      // Only rewrite if the URL points at one of our portal project pages
      if (/^\/portal\/(admin|pm|client)\/projects\//.test(u.pathname)) {
        u.pathname = targetPath;
        return u.toString();
      }
      return url;
    } catch {
      // Relative path — prefix frontend host
      const base = process.env.FRONTEND_URL || 'https://app.localwaves.ai';
      if (/^\/portal\/(admin|pm|client)\/projects\//.test(url)) {
        return `${base}${targetPath}`;
      }
      return url;
    }
  };

  // Helper: append ?reviewer=<name> to a URL so the preview/landing page can
  // attribute who is reviewing. Safe on malformed URLs (returns input).
  const appendReviewerParam = (url, name) => {
    if (!url || !name) return url;
    try {
      const u = new URL(url);
      u.searchParams.set('reviewer', name);
      return u.toString();
    } catch {
      return url;
    }
  };

  // 4. Pre-enrich shared context (detail card + comment thread) once
  const sharedContext = await buildSharedEmailContext(slug, variables, metadata);

  // 5. Process each recipient with their audience-specific copy
  for (const user of recipients) {
    const pref = user.notificationPreferences[0];
    const userEmailEnabled = pref ? pref.emailEnabled : true;
    const inAppEnabled = pref ? pref.inAppEnabled : true;

    const emailEnabled = userEmailEnabled && roleAllowsEmail(user);

    let emailSentAt = null;
    let emailError = null;
    const channel = emailEnabled && inAppEnabled ? 'both' : emailEnabled ? 'email' : inAppEnabled ? 'in_app' : 'none';

    if (channel === 'none') continue;

    // Resolve per-audience copy (variant if present, otherwise base template)
    const audience = audienceForUser(user);
    const source = resolveVariantForAudience(variantsByAudience, audience, template);
    const renderedSubject = renderTemplate(source.subject, variables);
    const renderedText = source.bodyText ? renderTemplate(source.bodyText, variables) : null;
    const renderedInApp = renderTemplate(source.inAppMessage, variables);

    // Per-recipient action URL: role-aware portal path + reviewer name
    const roleAwareUrl = rewritePortalUrlForUser(fullActionUrl, user);
    const userActionUrl = appendReviewerParam(roleAwareUrl, user.name);

    // Build branded HTML for this recipient (reuses shared enrichment)
    let brandedHtml;
    try {
      brandedHtml = await buildRichEmailHtml(slug, template.category, source, variables, userActionUrl, sharedContext);
    } catch (err) {
      console.error(`[notify] Rich email build failed for "${slug}"/${audience}, falling back:`, err.message);
      brandedHtml = await wrapInBrandedLayout({
        bodyHtml: renderTemplate(source.bodyHtml, variables),
        preheader: renderedSubject,
        actionUrl: userActionUrl,
        actionLabel: source.ctaLabel || CTA_LABEL_MAP[template.category] || 'View in Portal',
        category: template.category,
      });
    }

    // In-app: create SystemAlert (uses this recipient's inAppMessage)
    let alertId = null;
    if (inAppEnabled) {
      try {
        const alert = await prisma.systemAlert.create({
          data: {
            userId: user.id,
            type: slug,
            message: renderedInApp.slice(0, 500),
            actionUrl: actionUrl ? actionUrl.slice(0, 500) : null,
          },
        });
        alertId = alert.id;
      } catch (err) {
        console.error(`[notify] SystemAlert create failed for user ${user.id}:`, err.message);
      }
    }

    // Smart email deferral
    const shouldDeferEmail = emailEnabled && inAppEnabled && alertId;

    if (emailEnabled && !shouldDeferEmail) {
      try {
        const result = await sendEmail({
          to: user.email,
          subject: renderedSubject,
          html: brandedHtml,
          text: renderedText,
        });
        if (result.success) {
          emailSentAt = new Date();
        } else {
          emailError = result.error || 'Unknown error';
        }
      } catch (err) {
        emailError = err.message;
      }
    }

    // Log
    let logRecord;
    try {
      logRecord = await prisma.notificationLog.create({
        data: {
          recipientId: user.id,
          templateSlug: slug,
          channel,
          subject: renderedSubject.slice(0, 500),
          message: renderedInApp.slice(0, 2000),
          emailSentAt,
          emailError: emailError ? emailError.slice(0, 500) : null,
          emailDeferred: shouldDeferEmail ? true : false,
          actionUrl: actionUrl ? actionUrl.slice(0, 500) : null,
          metadata,
        },
      });
    } catch (err) {
      console.error(`[notify] Log create failed for user ${user.id}:`, err.message);
    }

    // Schedule deferred email
    if (shouldDeferEmail && logRecord) {
      deferEmail({
        logId: logRecord.id,
        alertId,
        to: user.email,
        subject: renderedSubject,
        html: brandedHtml,
        text: renderedText,
      });
    }
  }
}

/**
 * Test-send: render a template per audience and email it to arbitrary
 * addresses WITHOUT writing SystemAlerts, NotificationLogs, or touching
 * real recipients. Used by the WP "Notify > Test" flow so admins can preview
 * exactly what each audience will receive.
 *
 * @param {object}   opts
 * @param {string}   opts.slug              - Notification template slug
 * @param {object}   [opts.variables]       - Template variable values
 * @param {string}   [opts.actionUrl]       - CTA URL (already includes reviewer param if needed)
 * @param {object}   [opts.metadata]        - Extra context for shared email enrichment
 * @param {Array<{email:string, audience:string, name?:string}>} opts.testRecipients
 *        - Each entry: { email, audience: 'AGENCY_OWNER'|'AGENCY_TEAM'|'CLIENT_MANAGER'|'CLIENT_VIEWER', name? }
 * @returns {Promise<Array<{email:string, audience:string, success:boolean, error?:string}>>}
 */
export async function notifyTest({ slug, variables = {}, actionUrl = null, metadata = null, testRecipients = [] }) {
  const results = [];
  if (!Array.isArray(testRecipients) || testRecipients.length === 0) return results;

  // Fetch template
  let template;
  try {
    template = await prisma.notificationTemplate.findUnique({ where: { slug } });
  } catch (err) {
    console.error(`[notifyTest] Failed to fetch template "${slug}":`, err.message);
    return testRecipients.map((r) => ({ email: r.email, audience: r.audience, success: false, error: 'Template fetch failed' }));
  }
  if (!template) {
    return testRecipients.map((r) => ({ email: r.email, audience: r.audience, success: false, error: 'Template not found' }));
  }

  // Fetch per-audience variants
  const variantsByAudience = {};
  try {
    const variants = await prisma.notificationTemplateVariant.findMany({ where: { templateSlug: slug } });
    for (const v of variants) variantsByAudience[v.audience] = v;
  } catch (err) {
    console.warn(`[notifyTest] Variant fetch skipped for "${slug}":`, err.message);
  }

  // Resolve action URL to full URL if relative
  const fullActionUrl = actionUrl
    ? (actionUrl.startsWith('http') ? actionUrl : `${process.env.FRONTEND_URL || 'https://app.localwaves.ai'}${actionUrl}`)
    : null;

  // Pre-enrich shared context once
  const sharedContext = await buildSharedEmailContext(slug, variables, metadata);

  for (const recipient of testRecipients) {
    const email = String(recipient.email || '').trim();
    if (!email) continue;
    const audience = recipient.audience || 'AGENCY_TEAM';
    const reviewerName = recipient.name || `Test (${audience})`;

    // Append ?reviewer= for attribution (same behavior as real notify)
    let userActionUrl = fullActionUrl;
    if (userActionUrl && reviewerName) {
      try {
        const u = new URL(userActionUrl);
        u.searchParams.set('reviewer', reviewerName);
        userActionUrl = u.toString();
      } catch { /* keep as-is */ }
    }

    const source = resolveVariantForAudience(variantsByAudience, audience, template);
    const subject = `[TEST] ${renderTemplate(source.subject, variables)}`;
    const renderedText = source.bodyText ? renderTemplate(source.bodyText, variables) : null;

    let brandedHtml;
    try {
      brandedHtml = await buildRichEmailHtml(slug, template.category, source, variables, userActionUrl, sharedContext);
    } catch (err) {
      console.error(`[notifyTest] Rich email build failed for "${slug}"/${audience}:`, err.message);
      brandedHtml = await wrapInBrandedLayout({
        bodyHtml: renderTemplate(source.bodyHtml, variables),
        preheader: subject,
        actionUrl: userActionUrl,
        actionLabel: source.ctaLabel || CTA_LABEL_MAP[template.category] || 'View in Portal',
        category: template.category,
      });
    }

    // Prepend a visible test banner so it's obvious this is a test send
    const testBanner = '<div style="background:#fef3c7;border:1px solid #f59e0b;color:#92400e;padding:10px 14px;border-radius:6px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;margin-bottom:12px;">' +
      '<strong>⚠️ TEST EMAIL</strong> — Sent to <code>' + email + '</code> as audience <strong>' + audience + '</strong>. No real recipients were notified; no logs were recorded.' +
      '</div>';
    const htmlWithBanner = brandedHtml.replace(/<body([^>]*)>/i, (m) => m + testBanner);

    try {
      const result = await sendEmail({ to: email, subject, html: htmlWithBanner, text: renderedText });
      results.push({ email, audience, success: !!result.success, error: result.success ? undefined : (result.error || 'Unknown error') });
    } catch (err) {
      results.push({ email, audience, success: false, error: err.message });
    }
  }

  return results;
}
