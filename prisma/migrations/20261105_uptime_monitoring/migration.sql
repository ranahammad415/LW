-- Site metrics, uptime monitoring (docs/ledger/features/site-metrics.md): probes, incidents, daily rollup, and the
-- staff-only notification templates site_down / site_recovered / tls_expiring.
-- Additive and idempotent: CREATE TABLE IF NOT EXISTS with the foreign keys inline, INSERT IGNORE. Nothing dropped.

CREATE TABLE IF NOT EXISTS `uptimecheck` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `target` VARCHAR(8) NOT NULL,
  `source` VARCHAR(10) NOT NULL DEFAULT 'os',
  `ok` BOOLEAN NOT NULL,
  `httpStatus` INTEGER NULL,
  `ms` INTEGER NULL,
  `errorClass` VARCHAR(12) NULL,
  `tlsExpiresAt` DATETIME(3) NULL,
  INDEX `uptimecheck_projectId_at_idx`(`projectId`, `at`),
  INDEX `uptimecheck_at_idx`(`at`),
  PRIMARY KEY (`id`),
  CONSTRAINT `uptimecheck_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `uptimeincident` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `openedAt` DATETIME(3) NOT NULL,
  `closedAt` DATETIME(3) NULL,
  `cause` VARCHAR(12) NOT NULL,
  `lastError` VARCHAR(120) NULL,
  `durationSec` INTEGER NULL,
  `notifiedDownAt` DATETIME(3) NULL,
  `notifiedUpAt` DATETIME(3) NULL,
  `openProjectId` VARCHAR(191) NULL,
  UNIQUE INDEX `uptimeincident_openProjectId_key`(`openProjectId`),
  INDEX `uptimeincident_projectId_openedAt_idx`(`projectId`, `openedAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `uptimeincident_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `uptimedaily` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `date` DATE NOT NULL,
  `checks` INTEGER NOT NULL,
  `okChecks` INTEGER NOT NULL,
  `availabilityPct` DOUBLE NULL,
  `avgMs` INTEGER NULL,
  `p95Ms` INTEGER NULL,
  `incidents` INTEGER NOT NULL DEFAULT 0,
  `downtimeSec` INTEGER NOT NULL DEFAULT 0,
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `uptimedaily_date_idx`(`date`),
  UNIQUE INDEX `uptimedaily_projectId_date_key`(`projectId`, `date`),
  PRIMARY KEY (`id`),
  CONSTRAINT `uptimedaily_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Staff-only templates (owners + PMs by email; never clients). Same rows as prisma/seed-notifications.js.
INSERT IGNORE INTO `notificationtemplate`
  (`id`, `slug`, `name`, `description`, `category`, `subject`, `bodyHtml`, `bodyText`, `inAppMessage`, `variables`, `isActive`, `emailAgencyOwner`, `emailPm`, `emailClientManager`, `emailClientViewer`, `createdAt`, `updatedAt`)
VALUES
  (UUID(), 'site_down', 'Website Down', 'A client website failed two uptime probes in a row (agency on-call + owners; staff only)', 'security',
   'Website down: {{projectName}}',
   '<p><strong>{{projectName}}</strong> is not responding ({{reason}}) since {{since}}.</p><p>Open the project Site performance tab for the probe history.</p>',
   '{{projectName}} is not responding ({{reason}}) since {{since}}. Open the project Site performance tab for the probe history.',
   'Website down: {{projectName}} ({{reason}})',
   JSON_ARRAY('projectName','reason','since','actionUrl'), 1, 1, 1, 0, 0, NOW(3), NOW(3));

INSERT IGNORE INTO `notificationtemplate`
  (`id`, `slug`, `name`, `description`, `category`, `subject`, `bodyHtml`, `bodyText`, `inAppMessage`, `variables`, `isActive`, `emailAgencyOwner`, `emailPm`, `emailClientManager`, `emailClientViewer`, `createdAt`, `updatedAt`)
VALUES
  (UUID(), 'site_recovered', 'Website Recovered', 'A client website that was down responds again (staff only)', 'security',
   'Website back up: {{projectName}}',
   '<p><strong>{{projectName}}</strong> is responding again. It was down for {{duration}}.</p>',
   '{{projectName}} is responding again. It was down for {{duration}}.',
   'Website back up: {{projectName}} (down {{duration}})',
   JSON_ARRAY('projectName','duration','actionUrl'), 1, 1, 1, 0, 0, NOW(3), NOW(3));

INSERT IGNORE INTO `notificationtemplate`
  (`id`, `slug`, `name`, `description`, `category`, `subject`, `bodyHtml`, `bodyText`, `inAppMessage`, `variables`, `isActive`, `emailAgencyOwner`, `emailPm`, `emailClientManager`, `emailClientViewer`, `createdAt`, `updatedAt`)
VALUES
  (UUID(), 'tls_expiring', 'TLS Certificate Expiring', 'The https certificate of a client website expires in under 14 days (at most once a day; staff only)', 'security',
   'Certificate expiring: {{projectName}} ({{daysLeft}} days)',
   '<p>The https certificate of <strong>{{projectName}}</strong> expires on {{expiresAt}} ({{daysLeft}} days).</p><p>Renew it before visitors see a browser warning.</p>',
   'The https certificate of {{projectName}} expires on {{expiresAt}} ({{daysLeft}} days). Renew it before visitors see a browser warning.',
   'Certificate of {{projectName}} expires in {{daysLeft}} days',
   JSON_ARRAY('projectName','expiresAt','daysLeft','actionUrl'), 1, 1, 1, 0, 0, NOW(3), NOW(3));
