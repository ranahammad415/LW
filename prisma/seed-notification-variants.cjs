/**
 * Seed per-audience notification template variants.
 *
 * Audiences:
 *   AGENCY_OWNER    - strategic tone, surfaces client/account context.
 *   AGENCY_TEAM     - operational tone for PM / Team / Contractors.
 *   CLIENT_MANAGER  - client-friendly, no internal data.
 *   CLIENT_VIEWER   - short, read-only tone.
 *
 * Only authors variants for the audiences that actually receive email
 * per seed-notification-roles.cjs. Missing (audience, slug) pairs fall
 * back to the base template copy at send time (safe default).
 *
 * Idempotent: uses raw-SQL INSERT ... ON DUPLICATE KEY UPDATE so it can
 * run before the Prisma client is regenerated with the new model.
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { randomUUID } = require('crypto');

const prisma = new PrismaClient();

// Shorthand helpers for cleaner copy below.
const V = (subject, bodyHtml, bodyText, inAppMessage, ctaLabel) => ({
  subject,
  bodyHtml,
  bodyText,
  inAppMessage,
  ctaLabel,
});

// VARIANTS[slug][audience] = { subject, bodyHtml, bodyText, inAppMessage, ctaLabel }
const VARIANTS = {
  // ── Client / Account ──────────────────────────────────────────────────
  client_health_critical: {
    AGENCY_OWNER: V(
      '[Escalation] {{clientName}} health dropped to {{healthScore}}',
      '<p>The health score for <strong>{{clientName}}</strong> has dropped to <strong>{{healthScore}}</strong>. This account is now at risk of churn and needs owner-level attention.</p><p>Review the client profile for the latest flags, recent activity, and upcoming deliverables before your next check-in.</p>',
      'Client {{clientName}} health has dropped to {{healthScore}}. Review the account profile for the latest risk signals.',
      '{{clientName}} health critical ({{healthScore}})',
      'Open client account'
    ),
    AGENCY_TEAM: V(
      'Heads up: {{clientName}} health is now {{healthScore}}',
      '<p>The health score for <strong>{{clientName}}</strong> has dropped to <strong>{{healthScore}}</strong>. Please prioritise any pending deliverables on this account and flag blockers in your next standup.</p>',
      '{{clientName}} health is now {{healthScore}}. Prioritise deliverables and flag blockers.',
      '{{clientName}} health critical ({{healthScore}})',
      'Open client account'
    ),
  },

  client_intake_updated: {
    AGENCY_OWNER: V(
      '{{clientName}} updated their intake form',
      '<p><strong>{{clientName}}</strong> has updated their intake form. New business goals, audience details, or priorities may shift the account strategy.</p>',
      '{{clientName}} updated their intake form. Review the changes.',
      '{{clientName}} updated their intake form',
      'Review intake'
    ),
    AGENCY_TEAM: V(
      'Intake updated for {{clientName}}',
      '<p>The intake form for <strong>{{clientName}}</strong> was updated. Review the latest answers before your next working session and adjust any in-flight deliverables.</p>',
      'Intake for {{clientName}} was updated. Review before next working session.',
      'Intake updated: {{clientName}}',
      'Review intake'
    ),
    CLIENT_MANAGER: V(
      'We received your updated intake details',
      '<p>Thanks for keeping your intake up to date. Our team will review the latest information and adjust your plan where needed. No action is required from you right now.</p>',
      'Thanks for updating your intake. Our team will review and adjust your plan.',
      'Intake update received',
      'View my intake'
    ),
  },

  client_onboarding_complete: {
    AGENCY_OWNER: V(
      '{{clientName}} onboarding complete',
      '<p>Onboarding is complete for <strong>{{clientName}}</strong>. The account is ready for active delivery - kickoff calls, project plans, and first-month deliverables can now be scheduled.</p>',
      'Onboarding is complete for {{clientName}}. Ready for active delivery.',
      'Onboarding done: {{clientName}}',
      'Open client account'
    ),
    AGENCY_TEAM: V(
      '{{clientName}} onboarding finished - ready to start work',
      '<p>All onboarding steps for <strong>{{clientName}}</strong> have been completed. You can now start the first wave of deliverables. Check the project plan for priorities and due dates.</p>',
      '{{clientName}} onboarding complete. Start first deliverables per the project plan.',
      '{{clientName}} onboarding complete',
      'Open project plan'
    ),
    CLIENT_MANAGER: V(
      'You are all set - onboarding is complete',
      '<p>Great news - your onboarding is complete. Our team is now planning your first deliverables and will keep you posted with updates inside the portal.</p>',
      'Your onboarding is complete. Our team is now planning your first deliverables.',
      'Onboarding complete',
      'Go to portal'
    ),
  },

  password_reset: {
    AGENCY_OWNER: V(
      'Reset your Localwaves password',
      '<p>We received a request to reset your Localwaves password. Use the secure link in the portal to choose a new one. If this was not you, you can ignore this email.</p>',
      'A password reset was requested for your Localwaves account.',
      'Password reset requested',
      'Reset password'
    ),
    AGENCY_TEAM: V(
      'Reset your Localwaves password',
      '<p>A password reset was requested for your Localwaves account. Follow the secure link inside the portal. If this was not you, you can safely ignore this message.</p>',
      'A password reset was requested for your Localwaves account.',
      'Password reset requested',
      'Reset password'
    ),
    CLIENT_MANAGER: V(
      'Reset your Localwaves portal password',
      '<p>We received a password reset request for your Localwaves portal account. Use the secure link to choose a new password. If you did not request this, no changes have been made.</p>',
      'A password reset was requested for your Localwaves portal account.',
      'Password reset requested',
      'Reset password'
    ),
  },

  welcome_email: {
    AGENCY_OWNER: V(
      'Welcome to Localwaves',
      '<p>Welcome to Localwaves. Your owner account is ready - you have full visibility into every client, project, and deliverable across the agency.</p>',
      'Welcome to Localwaves. Your owner account is ready.',
      'Welcome to Localwaves',
      'Go to dashboard'
    ),
    AGENCY_TEAM: V(
      'Welcome to the Localwaves team',
      '<p>Welcome to Localwaves. Your team account is ready - head to the portal to see your assigned tasks, upcoming deadlines, and project details.</p>',
      'Welcome to the Localwaves team. See your assigned tasks in the portal.',
      'Welcome to Localwaves',
      'Open my tasks'
    ),
    CLIENT_MANAGER: V(
      'Welcome to your Localwaves client portal',
      '<p>Welcome. Your client portal is ready - approve deliverables, see progress, and submit requests any time from one place.</p>',
      'Welcome. Your Localwaves client portal is ready.',
      'Welcome to Localwaves',
      'Open my portal'
    ),
    CLIENT_VIEWER: V(
      'Welcome to your Localwaves portal',
      '<p>Welcome. Your portal is ready - you can view progress and deliverables at any time. This is a read-only view.</p>',
      'Welcome. Your read-only Localwaves portal is ready.',
      'Welcome to Localwaves',
      'Open portal'
    ),
  },

  // ── Client Input ──────────────────────────────────────────────────────
  client_asset_uploaded: {
    CLIENT_MANAGER: V(
      'Your file upload was received',
      '<p>Thanks - we have received your uploaded file <strong>{{fileName}}</strong>. Our team will incorporate it into your deliverables.</p>',
      'We received your uploaded file: {{fileName}}.',
      'File received: {{fileName}}',
      'View uploads'
    ),
  },

  client_business_update: {
    AGENCY_OWNER: V(
      '{{clientName}} posted a business update',
      '<p><strong>{{clientName}}</strong> shared a business update that may affect strategy. Review to decide if an account check-in is needed.</p>',
      '{{clientName}} posted a business update worth reviewing.',
      '{{clientName}} business update',
      'View update'
    ),
    AGENCY_TEAM: V(
      'Business update from {{clientName}}',
      '<p><strong>{{clientName}}</strong> shared a business update. Please review and reflect any changes in ongoing deliverables.</p>',
      '{{clientName}} shared a business update. Reflect changes in deliverables.',
      '{{clientName}} business update',
      'View update'
    ),
    CLIENT_MANAGER: V(
      'Thanks for the business update',
      '<p>Thanks for sharing your latest business update. Our team will review it and incorporate it into your plan.</p>',
      'Thanks for sharing your business update.',
      'Business update received',
      'View update'
    ),
  },

  client_input_fulfilled: {
    CLIENT_MANAGER: V(
      'Thanks - we have what we need',
      '<p>Thanks for responding to our input request. Our team has everything needed to move forward.</p>',
      'Thanks for your input - our team has what we need.',
      'Input received, thank you',
      'View request'
    ),
  },

  client_input_requested: {
    CLIENT_MANAGER: V(
      'We need a quick input from you: {{requestTitle}}',
      '<p>Our team needs a quick input to keep your project moving: <strong>{{requestTitle}}</strong>. Please respond when you have a moment.</p>',
      'We need your input: {{requestTitle}}. Please respond when you can.',
      'Input needed: {{requestTitle}}',
      'Respond now'
    ),
  },

  client_keyword_submitted: {
    AGENCY_OWNER: V(
      '{{clientName}} submitted new keywords',
      '<p><strong>{{clientName}}</strong> submitted new keywords for review. Assign these to the appropriate PM for validation.</p>',
      '{{clientName}} submitted new keywords for review.',
      'New keywords from {{clientName}}',
      'Review keywords'
    ),
    AGENCY_TEAM: V(
      'New keywords submitted by {{clientName}}',
      '<p><strong>{{clientName}}</strong> submitted new keywords. Validate them against the current strategy and flag any conflicts.</p>',
      '{{clientName}} submitted keywords. Validate against strategy.',
      'New keywords: {{clientName}}',
      'Review keywords'
    ),
    CLIENT_MANAGER: V(
      'We received your keywords',
      '<p>Thanks for submitting your keywords. Our team will review and include them in your strategy where they fit.</p>',
      'We received your keywords. Our team will review and incorporate them.',
      'Keywords received',
      'View keywords'
    ),
  },

  // ── Issues ────────────────────────────────────────────────────────────
  issue_assigned: {
    AGENCY_OWNER: V(
      'Issue assigned: {{issueTitle}}',
      '<p>An issue has been assigned to you: <strong>{{issueTitle}}</strong>. Review the details and set an owner if this should be re-assigned.</p>',
      'Issue assigned to you: {{issueTitle}}.',
      'Issue assigned: {{issueTitle}}',
      'Open issue'
    ),
    AGENCY_TEAM: V(
      '{{assignedBy}} assigned you an issue: {{issueTitle}}',
      '<p><strong>{{assignedBy}}</strong> assigned you a new issue: <strong>{{issueTitle}}</strong>. Open it to review the description, reproduction steps, and next action.</p>',
      '{{assignedBy}} assigned you issue "{{issueTitle}}".',
      'Issue assigned: {{issueTitle}}',
      'Open issue'
    ),
    CLIENT_MANAGER: V(
      'An issue was assigned to your project',
      '<p>An issue on your project has been assigned to a team member and is now being worked on. You can follow progress in the portal.</p>',
      'An issue on your project is now being worked on.',
      'Issue in progress: {{issueTitle}}',
      'View issue'
    ),
  },

  issue_comment_added: {
    AGENCY_OWNER: V(
      'New comment on issue: {{issueTitle}}',
      '<p><strong>{{authorName}}</strong> commented on issue <strong>{{issueTitle}}</strong>.</p><blockquote style="border-left:3px solid #6366f1;padding:8px 12px;margin:12px 0;background:#f8fafc;border-radius:4px;">{{commentPreview}}</blockquote>',
      '{{authorName}} commented on issue "{{issueTitle}}": {{commentPreview}}',
      '{{authorName}} commented on {{issueTitle}}',
      'Open issue'
    ),
    AGENCY_TEAM: V(
      '{{authorName}} commented on: {{issueTitle}}',
      '<p><strong>{{authorName}}</strong> added a comment to issue <strong>{{issueTitle}}</strong>:</p><blockquote style="border-left:3px solid #6366f1;padding:8px 12px;margin:12px 0;background:#f8fafc;border-radius:4px;">{{commentPreview}}</blockquote>',
      '{{authorName}} commented on issue "{{issueTitle}}": {{commentPreview}}',
      '{{authorName}} commented on {{issueTitle}}',
      'Open issue'
    ),
    CLIENT_MANAGER: V(
      'Update on your issue: {{issueTitle}}',
      '<p>There is a new update on your issue <strong>{{issueTitle}}</strong>:</p><blockquote style="border-left:3px solid #6366f1;padding:8px 12px;margin:12px 0;background:#f8fafc;border-radius:4px;">{{commentPreview}}</blockquote>',
      'New update on your issue "{{issueTitle}}": {{commentPreview}}',
      'Update on {{issueTitle}}',
      'View issue'
    ),
  },

  issue_created: {
    AGENCY_OWNER: V(
      'New issue reported: {{issueTitle}}',
      '<p>A new issue has been reported: <strong>{{issueTitle}}</strong>. Review severity and assign an owner if needed.</p>',
      'New issue reported: {{issueTitle}}.',
      'New issue: {{issueTitle}}',
      'Open issue'
    ),
    AGENCY_TEAM: V(
      'New issue logged: {{issueTitle}}',
      '<p>A new issue has been logged: <strong>{{issueTitle}}</strong>. Check the details and pick it up if it falls in your area.</p>',
      'New issue logged: {{issueTitle}}.',
      'New issue: {{issueTitle}}',
      'Open issue'
    ),
    CLIENT_MANAGER: V(
      'We logged your issue: {{issueTitle}}',
      '<p>Thanks for flagging this - we have logged your issue <strong>{{issueTitle}}</strong>. Our team will update you as it progresses.</p>',
      'We logged your issue: {{issueTitle}}. We will keep you posted.',
      'Issue logged: {{issueTitle}}',
      'View issue'
    ),
  },

  issue_resolved: {
    AGENCY_OWNER: V(
      'Issue resolved: {{issueTitle}}',
      '<p>The issue <strong>{{issueTitle}}</strong> has been marked as resolved. Review the outcome and close the loop with the client if appropriate.</p>',
      'Issue resolved: {{issueTitle}}.',
      'Resolved: {{issueTitle}}',
      'View issue'
    ),
    AGENCY_TEAM: V(
      'Issue resolved: {{issueTitle}}',
      '<p>The issue <strong>{{issueTitle}}</strong> has been marked as resolved. Thanks for closing it out.</p>',
      'Issue resolved: {{issueTitle}}.',
      'Resolved: {{issueTitle}}',
      'View issue'
    ),
    CLIENT_MANAGER: V(
      'Your issue is resolved: {{issueTitle}}',
      '<p>Good news - your issue <strong>{{issueTitle}}</strong> has been resolved. If anything still needs attention, reply in the portal and we will take another look.</p>',
      'Your issue is resolved: {{issueTitle}}.',
      'Resolved: {{issueTitle}}',
      'View issue'
    ),
  },

  // ── Pipeline ──────────────────────────────────────────────────────────
  content_published: {
    AGENCY_OWNER: V(
      'Content published: {{contentTitle}}',
      '<p><strong>{{contentTitle}}</strong> for <strong>{{clientName}}</strong> is now live. Confirm distribution or next-step promotion is scheduled.</p>',
      'Content "{{contentTitle}}" for {{clientName}} is live.',
      'Published: {{contentTitle}}',
      'View content'
    ),
    AGENCY_TEAM: V(
      'Published: {{contentTitle}}',
      '<p><strong>{{contentTitle}}</strong> has been published for <strong>{{clientName}}</strong>. Update the project log if there is follow-up work (socials, internal links, tracking).</p>',
      'Content "{{contentTitle}}" is live. Check follow-up tasks.',
      'Published: {{contentTitle}}',
      'View content'
    ),
    CLIENT_MANAGER: V(
      'Your content is live: {{contentTitle}}',
      '<p>Great news - <strong>{{contentTitle}}</strong> is now published. Take a look and let us know if you have any feedback.</p>',
      'Your content "{{contentTitle}}" is live.',
      'Live: {{contentTitle}}',
      'View content'
    ),
  },

  content_ready_for_client_review: {
    AGENCY_OWNER: V(
      'Awaiting client review: {{contentTitle}}',
      '<p><strong>{{contentTitle}}</strong> for <strong>{{clientName}}</strong> has been sent for client review. Watch the pipeline for pickup and response time.</p>',
      '{{contentTitle}} for {{clientName}} is awaiting client review.',
      'Awaiting client: {{contentTitle}}',
      'Open pipeline'
    ),
    AGENCY_TEAM: V(
      'Sent to client: {{contentTitle}}',
      '<p><strong>{{contentTitle}}</strong> has been sent to <strong>{{clientName}}</strong> for review. You will be notified once they approve or request changes.</p>',
      '{{contentTitle}} was sent to {{clientName}} for review.',
      'Sent to client: {{contentTitle}}',
      'Open pipeline'
    ),
    CLIENT_MANAGER: V(
      'Please review: {{contentTitle}}',
      '<p>Your content <strong>{{contentTitle}}</strong> is ready for your review. Open it in the portal to approve or request changes.</p>',
      'Your content "{{contentTitle}}" is ready for review.',
      'Review: {{contentTitle}}',
      'Review content'
    ),
  },

  content_submitted_for_review: {
    AGENCY_OWNER: V(
      'PM review needed: {{contentTitle}}',
      '<p><strong>{{contentTitle}}</strong> was submitted and is awaiting PM review before going to the client.</p>',
      '{{contentTitle}} is awaiting PM review.',
      'PM review: {{contentTitle}}',
      'Review content'
    ),
    AGENCY_TEAM: V(
      'Review content: {{contentTitle}}',
      '<p><strong>{{submittedBy}}</strong> submitted <strong>{{contentTitle}}</strong> for review. Approve it or request changes before it goes to the client.</p>',
      '{{submittedBy}} submitted "{{contentTitle}}" for PM review.',
      'Review needed: {{contentTitle}}',
      'Review content'
    ),
    CLIENT_MANAGER: V(
      'Your content is in review',
      '<p>Our team is reviewing <strong>{{contentTitle}}</strong> internally before sending it to you. You will hear from us once it is ready.</p>',
      'Your content "{{contentTitle}}" is in internal review.',
      'In review: {{contentTitle}}',
      'View content'
    ),
  },

  // ── Projects ──────────────────────────────────────────────────────────
  project_created: {
    AGENCY_OWNER: V(
      'New project: {{projectName}}',
      '<p>A new project <strong>{{projectName}}</strong> has been created for <strong>{{clientName}}</strong>. Confirm scope, budget, and PM assignment are in place.</p>',
      'New project {{projectName}} created for {{clientName}}.',
      'New project: {{projectName}}',
      'Open project'
    ),
    AGENCY_TEAM: V(
      'Project spun up: {{projectName}}',
      '<p>Project <strong>{{projectName}}</strong> has been created. Start by reviewing the scope, timeline, and first-wave tasks assigned to you.</p>',
      'Project {{projectName}} created. Review scope and tasks.',
      'Project: {{projectName}}',
      'Open project'
    ),
  },

  // ── Report ────────────────────────────────────────────────────────────
  report_published: {
    AGENCY_OWNER: V(
      '{{clientName}} report published - {{monthLabel}}',
      '<p>The <strong>{{monthLabel}}</strong> report for <strong>{{clientName}}</strong> has been published. Review the highlights and flag any strategic follow-ups.</p>',
      '{{monthLabel}} report for {{clientName}} is live.',
      'Report live: {{clientName}} - {{monthLabel}}',
      'View report'
    ),
    AGENCY_TEAM: V(
      'Report published: {{clientName}} - {{monthLabel}}',
      '<p>The <strong>{{monthLabel}}</strong> report for <strong>{{clientName}}</strong> is now published. Make sure any follow-up actions are captured in the project plan.</p>',
      '{{monthLabel}} report for {{clientName}} is published.',
      'Report: {{clientName}} - {{monthLabel}}',
      'View report'
    ),
    CLIENT_MANAGER: V(
      'Your {{monthLabel}} report is ready',
      '<p>Your <strong>{{monthLabel}}</strong> performance report is ready. Open it in the portal to see results, highlights, and next steps.</p>',
      'Your {{monthLabel}} performance report is ready.',
      'Report ready: {{monthLabel}}',
      'View report'
    ),
    CLIENT_VIEWER: V(
      'Your {{monthLabel}} report is available',
      '<p>Your <strong>{{monthLabel}}</strong> report is available to view in the portal.</p>',
      'Your {{monthLabel}} report is available.',
      'Report available: {{monthLabel}}',
      'View report'
    ),
  },

  // ── Tasks ─────────────────────────────────────────────────────────────
  task_assigned: {
    AGENCY_OWNER: V(
      'Task assigned to you: {{taskTitle}}',
      '<p>You have been assigned <strong>{{taskTitle}}</strong> on project <strong>{{projectName}}</strong>. Usually reassign to the right owner unless this is yours.</p>',
      'Task "{{taskTitle}}" in {{projectName}} assigned to you.',
      'Assigned: {{taskTitle}}',
      'Open task'
    ),
    AGENCY_TEAM: V(
      'New assignment: {{taskTitle}} in {{projectName}}',
      '<p><strong>{{assignedBy}}</strong> assigned you <strong>{{taskTitle}}</strong> in <strong>{{projectName}}</strong>. Open the task to see the checklist, dependencies, and due date.</p>',
      '{{assignedBy}} assigned you task "{{taskTitle}}" in {{projectName}}.',
      'Assigned: {{taskTitle}}',
      'Open task'
    ),
    CLIENT_MANAGER: V(
      'Work started on your project: {{taskTitle}}',
      '<p>Our team has picked up <strong>{{taskTitle}}</strong> for your project <strong>{{projectName}}</strong>. You can follow progress in the portal.</p>',
      'Our team is now working on {{taskTitle}} for your project.',
      'In progress: {{taskTitle}}',
      'View progress'
    ),
  },

  task_comment_added: {
    AGENCY_OWNER: V(
      'New comment on task: {{taskTitle}}',
      '<p><strong>{{authorName}}</strong> commented on task <strong>{{taskTitle}}</strong> ({{projectName}}):</p><blockquote style="border-left:3px solid #6366f1;padding:8px 12px;margin:12px 0;background:#f8fafc;border-radius:4px;">{{commentPreview}}</blockquote>',
      '{{authorName}} commented on "{{taskTitle}}": {{commentPreview}}',
      '{{authorName}} commented on {{taskTitle}}',
      'Open task'
    ),
    AGENCY_TEAM: V(
      '{{authorName}} commented on: {{taskTitle}}',
      '<p><strong>{{authorName}}</strong> added a comment to <strong>{{taskTitle}}</strong> in <strong>{{projectName}}</strong>:</p><blockquote style="border-left:3px solid #6366f1;padding:8px 12px;margin:12px 0;background:#f8fafc;border-radius:4px;">{{commentPreview}}</blockquote>',
      '{{authorName}} commented on "{{taskTitle}}": {{commentPreview}}',
      '{{authorName}} commented on {{taskTitle}}',
      'Open task'
    ),
    CLIENT_MANAGER: V(
      'Update on {{taskTitle}}',
      '<p>There is a new update on <strong>{{taskTitle}}</strong> for your project <strong>{{projectName}}</strong>:</p><blockquote style="border-left:3px solid #6366f1;padding:8px 12px;margin:12px 0;background:#f8fafc;border-radius:4px;">{{commentPreview}}</blockquote>',
      'New update on "{{taskTitle}}": {{commentPreview}}',
      'Update on {{taskTitle}}',
      'View task'
    ),
  },

  task_completed: {
    AGENCY_OWNER: V(
      'Task completed: {{taskTitle}} - {{projectName}}',
      '<p><strong>{{taskTitle}}</strong> on project <strong>{{projectName}}</strong> has been completed by {{completedBy}}. Confirm the deliverable quality and that the next step is queued.</p>',
      'Task "{{taskTitle}}" completed by {{completedBy}}.',
      'Completed: {{taskTitle}}',
      'View task'
    ),
    AGENCY_TEAM: V(
      'Done: {{taskTitle}}',
      '<p>Nice work - <strong>{{taskTitle}}</strong> has been marked complete. If any handoff or review is needed, update the project log.</p>',
      'Task "{{taskTitle}}" completed by {{completedBy}}.',
      'Completed: {{taskTitle}}',
      'View task'
    ),
    CLIENT_MANAGER: V(
      'Update: "{{taskTitle}}" is complete',
      '<p>Our team has finished <strong>{{taskTitle}}</strong> for your project <strong>{{projectName}}</strong>. Log in to see the deliverable.</p>',
      'Our team has finished "{{taskTitle}}" for your project.',
      'Completed: {{taskTitle}}',
      'View deliverable'
    ),
    CLIENT_VIEWER: V(
      '"{{taskTitle}}" is complete',
      '<p><strong>{{taskTitle}}</strong> on your project <strong>{{projectName}}</strong> is complete.</p>',
      '"{{taskTitle}}" on your project is complete.',
      'Completed: {{taskTitle}}',
      'View task'
    ),
  },

  task_created: {
    AGENCY_OWNER: V(
      'New task in {{projectName}}: {{taskTitle}}',
      '<p>A new task <strong>{{taskTitle}}</strong> was created in <strong>{{projectName}}</strong>. Ensure it is assigned to the right owner and has a due date.</p>',
      'New task "{{taskTitle}}" in {{projectName}}.',
      'New task: {{taskTitle}}',
      'Open task'
    ),
    AGENCY_TEAM: V(
      'New task: {{taskTitle}}',
      '<p>A new task has been added to <strong>{{projectName}}</strong>: <strong>{{taskTitle}}</strong>. Open it to see description, checklist, and assignment.</p>',
      'New task "{{taskTitle}}" in {{projectName}}.',
      'New task: {{taskTitle}}',
      'Open task'
    ),
    CLIENT_MANAGER: V(
      'New work planned: {{taskTitle}}',
      '<p>A new piece of work has been added to your project <strong>{{projectName}}</strong>: <strong>{{taskTitle}}</strong>. You can follow it in the portal.</p>',
      'New work planned on your project: "{{taskTitle}}".',
      'Planned: {{taskTitle}}',
      'View task'
    ),
  },

  task_overdue: {
    AGENCY_OWNER: V(
      '[Overdue] {{taskTitle}} - {{projectName}}',
      '<p><strong>{{taskTitle}}</strong> in <strong>{{projectName}}</strong> is overdue. Confirm next steps with the assignee or reassign if needed.</p>',
      'Task "{{taskTitle}}" in {{projectName}} is overdue.',
      'Overdue: {{taskTitle}}',
      'Open task'
    ),
    AGENCY_TEAM: V(
      'Overdue: {{taskTitle}}',
      '<p>Your task <strong>{{taskTitle}}</strong> in <strong>{{projectName}}</strong> is now past its due date. Please update the status or flag a blocker.</p>',
      'Your task "{{taskTitle}}" is overdue.',
      'Overdue: {{taskTitle}}',
      'Open task'
    ),
    CLIENT_MANAGER: V(
      'We are working on a delay with {{taskTitle}}',
      '<p>We wanted to let you know <strong>{{taskTitle}}</strong> on your project <strong>{{projectName}}</strong> is running behind. Our team is on it and will update you shortly.</p>',
      '"{{taskTitle}}" on your project is running behind. Our team is on it.',
      'Delay on {{taskTitle}}',
      'View task'
    ),
  },
};

async function main() {
  // 1. Fetch existing template slugs so we only author for known templates.
  const dbRows = await prisma.$queryRawUnsafe(
    'SELECT slug FROM notificationtemplate'
  );
  const dbSlugs = new Set(dbRows.map((r) => r.slug));

  const missingInDb = Object.keys(VARIANTS).filter((s) => !dbSlugs.has(s));
  if (missingInDb.length) {
    console.warn(
      `[seed-notification-variants] ${missingInDb.length} slug(s) in VARIANTS but not in DB (skipped):`,
      missingInDb.join(', ')
    );
  }

  // 2. Upsert every (slug, audience) variant via raw SQL so this runs
  //    even if the Prisma client has not been regenerated.
  let authored = 0;
  const touchedSlugs = new Set();

  for (const [slug, perAudience] of Object.entries(VARIANTS)) {
    if (!dbSlugs.has(slug)) continue;

    for (const [audience, variant] of Object.entries(perAudience)) {
      const id = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO notificationtemplatevariant
           (id, templateSlug, audience, subject, bodyHtml, bodyText, inAppMessage, ctaLabel, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE
           subject      = VALUES(subject),
           bodyHtml     = VALUES(bodyHtml),
           bodyText     = VALUES(bodyText),
           inAppMessage = VALUES(inAppMessage),
           ctaLabel     = VALUES(ctaLabel),
           updatedAt    = NOW()`,
        id,
        slug,
        audience,
        variant.subject,
        variant.bodyHtml,
        variant.bodyText,
        variant.inAppMessage,
        variant.ctaLabel
      );
      authored += 1;
      touchedSlugs.add(slug);
    }
  }

  console.log(
    `[seed-notification-variants] Authored ${authored} variants across ${touchedSlugs.size} templates.`
  );
}

main()
  .catch((err) => {
    console.error('[seed-notification-variants] Failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
