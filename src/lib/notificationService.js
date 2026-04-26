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
 * Build rich email HTML using components + enriched data.
 * Falls back to simple bodyHtml if enrichment fails.
 */
async function buildRichEmailHtml(slug, template, variables, actionUrl, metadata) {
  const actorName = variables.authorName || variables.assignedBy || variables.changedBy ||
                    variables.completedBy || variables.uploadedBy || variables.submittedBy ||
                    variables.senderName || variables.memberName || 'Localwaves';
  const actionText = ACTION_TEXT_MAP[slug] || '';
  const projectName = variables.projectName || '';
  const ctaLabel = CTA_LABEL_MAP[template.category] || 'View in Portal';

  // Rendered simple body from template (fallback content)
  const renderedBodyHtml = renderTemplate(template.bodyHtml, variables);

  // If no actorName available (system notifications), use simple layout
  if (!actionText) {
    return wrapInBrandedLayout({
      bodyHtml: renderedBodyHtml,
      preheader: renderTemplate(template.subject, variables),
      actionUrl,
      actionLabel: ctaLabel,
      category: template.category,
    });
  }

  // Build the action header component
  const actionHeaderHtml = actionHeader({
    actorName,
    actionText,
    contextLine: projectName ? `Localwaves \u2013 ${projectName}` : 'Localwaves',
  });

  // Build comment block (for comment/mention notifications)
  let commentBlockHtml = '';
  const commentPreview = variables.commentPreview || variables.requestNote || variables.messagePreview || '';
  if (commentPreview && (slug.includes('comment') || slug.includes('mention'))) {
    commentBlockHtml = commentBlock(actorName, commentPreview);
  }

  // Enrich and build task detail card
  let detailCardHtml = '';
  const taskId = metadata?.taskId;
  const issueId = metadata?.issueId;

  if (taskId && TASK_CARD_SLUGS.has(slug)) {
    const taskData = await enrichTaskData(taskId);
    if (taskData) {
      detailCardHtml = taskDetailCard(taskData);
    }
  } else if (issueId && ISSUE_CARD_SLUGS.has(slug)) {
    const issueData = await enrichIssueData(issueId);
    if (issueData) {
      detailCardHtml = issueDetailCard(issueData);
    }
  }

  // Enrich and build comment thread
  let commentThreadHtml = '';
  if (taskId && COMMENT_THREAD_SLUGS.has(slug)) {
    const comments = await enrichRecentComments(taskId, 4);
    if (comments.length > 0) {
      commentThreadHtml = commentThread(comments);
    }
  } else if (issueId && ISSUE_COMMENT_SLUGS.has(slug)) {
    const comments = await enrichIssueComments(issueId, 4);
    if (comments.length > 0) {
      commentThreadHtml = commentThread(comments);
    }
  }

  return wrapInBrandedLayout({
    bodyHtml: (!commentBlockHtml && !detailCardHtml) ? renderedBodyHtml : '',
    preheader: renderTemplate(template.subject, variables),
    actionUrl,
    actionLabel: ctaLabel,
    category: template.category,
    actionHeaderHtml,
    commentBlockHtml,
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

  // 2. Fetch recipients + preferences
  const recipients = await prisma.user.findMany({
    where: { id: { in: uniqueIds }, isActive: true },
    select: {
      id: true,
      email: true,
      name: true,
      notificationPreferences: {
        where: { templateSlug: slug },
        select: { emailEnabled: true, inAppEnabled: true },
      },
    },
  });

  // 3. Render simple template content (for in-app + subject + plaintext)
  const renderedSubject = renderTemplate(template.subject, variables);
  const renderedText = template.bodyText ? renderTemplate(template.bodyText, variables) : null;
  const renderedInApp = renderTemplate(template.inAppMessage, variables);

  // 4. Build rich email HTML (with enriched task cards, comment threads, etc.)
  //    Resolve actionUrl to full URL if it's a relative path
  const fullActionUrl = actionUrl
    ? (actionUrl.startsWith('http') ? actionUrl : `${process.env.FRONTEND_URL || 'https://app.localwaves.ai'}${actionUrl}`)
    : null;

  let brandedHtml;
  try {
    brandedHtml = await buildRichEmailHtml(slug, template, variables, fullActionUrl, metadata);
  } catch (err) {
    console.error(`[notify] Rich email build failed for "${slug}", falling back:`, err.message);
    // Fallback to simple layout
    brandedHtml = await wrapInBrandedLayout({
      bodyHtml: renderTemplate(template.bodyHtml, variables),
      preheader: renderedSubject,
      actionUrl: fullActionUrl,
      actionLabel: 'View in Portal',
      category: template.category,
    });
  }

  // 5. Process each recipient
  for (const user of recipients) {
    const pref = user.notificationPreferences[0];
    const emailEnabled = pref ? pref.emailEnabled : true;
    const inAppEnabled = pref ? pref.inAppEnabled : true;

    let emailSentAt = null;
    let emailError = null;
    const channel = emailEnabled && inAppEnabled ? 'both' : emailEnabled ? 'email' : inAppEnabled ? 'in_app' : 'none';

    if (channel === 'none') continue;

    // In-app: create SystemAlert
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
