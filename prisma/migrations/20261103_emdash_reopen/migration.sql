-- EmDash bridge v1.5.9 (§35): reopen after client approval. Additive, idempotent: one notification template row.

-- ── Notification template: content_review_reopened (project lead PM; in-app only, every e-mail flag off) ──
INSERT IGNORE INTO `notificationtemplate`
  (`id`, `slug`, `name`, `description`, `category`, `subject`, `bodyHtml`, `bodyText`, `inAppMessage`, `variables`, `isActive`, `emailAgencyOwner`, `emailPm`, `emailClientManager`, `emailClientViewer`, `createdAt`, `updatedAt`)
VALUES
  (UUID(), 'content_review_reopened', 'Content Back to Client Review', 'The content changed on the site after the client approved it, so it went back to client review (EmDash)', 'pipeline',
   '[Back to client review] "{{postTitle}}" - {{projectName}}',
   '<p><strong>&ldquo;{{postTitle}}&rdquo;</strong> ({{postType}}) in project <strong>{{projectName}}</strong> went back to client review (round {{round}}): {{changedBy}} changed the content after the client approved it. Changed: {{changedSummary}}</p>',
   '"{{postTitle}}" ({{postType}}) in project "{{projectName}}" went back to client review (round {{round}}): {{changedBy}} changed the content after the client approved it. Changed: {{changedSummary}}',
   '[{{projectName}}] "{{postTitle}}" is back in client review (round {{round}}): changed by {{changedBy}} after client approval',
   JSON_ARRAY('postTitle','projectName','postType','round','changedBy','changedSummary','actionUrl'), 1, 0, 0, 0, 0, NOW(3), NOW(3));
