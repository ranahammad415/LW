/**
 * Seed role-based email recipients for each NotificationTemplate.
 *
 * Source of truth: LocalWaves_Notifications_Review (2).xlsx
 *
 * Columns mapped:
 *   owner  -> emailAgencyOwner   (User.role = OWNER)
 *   pm     -> emailPm            (User.role in PM | TEAM_MEMBER | CONTRACTOR)
 *   mgr    -> emailClientManager (CLIENT user with ClientUser.role = 'MANAGER')
 *   viewer -> emailClientViewer  (CLIENT user with ClientUser.role = 'VIEWER')
 *
 * Per product decisions:
 *   - PM defaults to the Agency Owner column from the spreadsheet.
 *   - "Active + no x in any column" rows remain isActive=true but have all four
 *     email flags set to false (in-app still fires; email is suppressed).
 *   - "Disabled" rows get isActive=false AND all four email flags set to false.
 *
 * Uses raw SQL so this script can run even if the Prisma client has not yet
 * been regenerated with the new columns.
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// active, owner, pm, mgr, viewer
const MATRIX = {
  // Client / Account
  client_health_critical:        { active: true,  owner: 1, pm: 1, mgr: 0, viewer: 0 },
  client_intake_updated:         { active: true,  owner: 1, pm: 1, mgr: 1, viewer: 0 },
  client_onboarding_complete:    { active: true,  owner: 1, pm: 1, mgr: 1, viewer: 0 },
  password_reset:                { active: true,  owner: 1, pm: 1, mgr: 1, viewer: 0 }, // informational - sent via direct sendEmail()
  welcome_email:                 { active: true,  owner: 1, pm: 1, mgr: 1, viewer: 1 },

  // Client Input
  client_asset_uploaded:         { active: true,  owner: 0, pm: 0, mgr: 1, viewer: 0 },
  client_business_update:        { active: true,  owner: 1, pm: 1, mgr: 1, viewer: 0 },
  client_input_fulfilled:        { active: true,  owner: 0, pm: 0, mgr: 1, viewer: 0 },
  client_input_requested:        { active: true,  owner: 0, pm: 0, mgr: 1, viewer: 0 },
  client_keyword_submitted:      { active: true,  owner: 1, pm: 1, mgr: 1, viewer: 0 },

  // Issues
  issue_assigned:                { active: true,  owner: 1, pm: 1, mgr: 1, viewer: 0 },
  issue_comment_added:           { active: true,  owner: 1, pm: 1, mgr: 1, viewer: 0 },
  issue_created:                 { active: true,  owner: 1, pm: 1, mgr: 1, viewer: 0 },
  issue_resolved:                { active: true,  owner: 1, pm: 1, mgr: 1, viewer: 0 },
  issue_status_changed:          { active: false, owner: 0, pm: 0, mgr: 0, viewer: 0 },
  user_mentioned_in_issue:       { active: false, owner: 0, pm: 0, mgr: 0, viewer: 0 },

  // Keyword (all disabled per review)
  keyword_edit_suggested:        { active: false, owner: 0, pm: 0, mgr: 0, viewer: 0 },
  keyword_suggestion_approved:   { active: false, owner: 0, pm: 0, mgr: 0, viewer: 0 },
  keyword_suggestion_rejected:   { active: false, owner: 0, pm: 0, mgr: 0, viewer: 0 },
  keyword_approved_by_client:    { active: false, owner: 0, pm: 0, mgr: 0, viewer: 0 },
  keyword_rejected_by_client:    { active: false, owner: 0, pm: 0, mgr: 0, viewer: 0 },

  // Meetings
  meeting_scheduled:             { active: false, owner: 0, pm: 0, mgr: 0, viewer: 0 },

  // Pipeline
  content_client_approved:         { active: true, owner: 0, pm: 0, mgr: 0, viewer: 0 }, // in-app only
  content_client_changes_requested:{ active: true, owner: 0, pm: 0, mgr: 0, viewer: 0 }, // in-app only
  content_pm_approved:             { active: true, owner: 0, pm: 0, mgr: 0, viewer: 0 }, // in-app only
  content_pm_changes_requested:    { active: true, owner: 0, pm: 0, mgr: 0, viewer: 0 }, // in-app only
  content_published:               { active: true, owner: 1, pm: 1, mgr: 1, viewer: 0 },
  content_ready_for_client_review: { active: true, owner: 1, pm: 1, mgr: 1, viewer: 0 },
  content_submitted_for_review:    { active: true, owner: 1, pm: 1, mgr: 1, viewer: 0 },

  // Projects
  project_created:               { active: true,  owner: 1, pm: 1, mgr: 0, viewer: 0 },

  // Report
  report_published:              { active: true,  owner: 1, pm: 1, mgr: 1, viewer: 1 },

  // Standup
  standup_submitted:             { active: false, owner: 0, pm: 0, mgr: 0, viewer: 0 },

  // Tasks
  task_deliverable_uploaded:     { active: false, owner: 0, pm: 0, mgr: 0, viewer: 0 },
  user_mentioned_in_task:        { active: true,  owner: 0, pm: 0, mgr: 0, viewer: 0 }, // in-app only
  task_assigned:                 { active: true,  owner: 1, pm: 1, mgr: 1, viewer: 0 },
  task_comment_added:            { active: true,  owner: 1, pm: 1, mgr: 1, viewer: 0 },
  task_completed:                { active: true,  owner: 1, pm: 1, mgr: 1, viewer: 1 },
  task_created:                  { active: true,  owner: 1, pm: 1, mgr: 1, viewer: 0 },
  task_overdue:                  { active: true,  owner: 1, pm: 1, mgr: 1, viewer: 0 },
  task_stagnant:                 { active: false, owner: 0, pm: 0, mgr: 0, viewer: 0 },
  task_status_changed:           { active: false, owner: 0, pm: 0, mgr: 0, viewer: 0 },
  task_unassigned:               { active: false, owner: 0, pm: 0, mgr: 0, viewer: 0 },
};

async function main() {
  // 1. Reconcile against DB (log missing / extra rows).
  const dbRows = await prisma.$queryRawUnsafe(
    'SELECT slug FROM notificationtemplate'
  );
  const dbSlugs = new Set(dbRows.map((r) => r.slug));
  const matrixSlugs = new Set(Object.keys(MATRIX));

  const missingInDb = [...matrixSlugs].filter((s) => !dbSlugs.has(s));
  const missingInMatrix = [...dbSlugs].filter((s) => !matrixSlugs.has(s));

  if (missingInDb.length) {
    console.warn(
      `[seed-notification-roles] ${missingInDb.length} slug(s) in MATRIX but not in DB:`,
      missingInDb.join(', ')
    );
  }
  if (missingInMatrix.length) {
    console.warn(
      `[seed-notification-roles] ${missingInMatrix.length} slug(s) in DB but not in MATRIX (left unchanged):`,
      missingInMatrix.join(', ')
    );
  }

  // 2. Apply role flags via parameterized UPDATEs.
  let applied = 0;
  for (const [slug, cfg] of Object.entries(MATRIX)) {
    if (!dbSlugs.has(slug)) continue;
    const result = await prisma.$executeRawUnsafe(
      `UPDATE notificationtemplate
         SET isActive = ?,
             emailAgencyOwner = ?,
             emailPm = ?,
             emailClientManager = ?,
             emailClientViewer = ?
       WHERE slug = ?`,
      cfg.active ? 1 : 0,
      cfg.owner ? 1 : 0,
      cfg.pm ? 1 : 0,
      cfg.mgr ? 1 : 0,
      cfg.viewer ? 1 : 0,
      slug
    );
    if (result > 0) applied += 1;
  }

  console.log(
    `[seed-notification-roles] Updated ${applied} / ${Object.keys(MATRIX).length} templates.`
  );
}

main()
  .catch((err) => {
    console.error('[seed-notification-roles] Failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
