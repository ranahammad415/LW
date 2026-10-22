-- Health score v2 (docs/ledger/features/health-score.md), Phase 1 + quick wins (keyword rank history, LLM referrals).
-- Additive and idempotent: guarded ADD COLUMNs, CREATE TABLE IF NOT EXISTS, INSERT IGNORE. Nothing dropped, renamed or retyped.
-- The old client_health_critical template is only deactivated (isActive = 0), never deleted.

SET @db := DATABASE();

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'clientaccount' AND COLUMN_NAME = 'healthCoverage');
SET @sql := IF(@col = 0,
  'ALTER TABLE `clientaccount` ADD COLUMN `healthCoverage` INTEGER NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'clientaccount' AND COLUMN_NAME = 'healthTrend28');
SET @sql := IF(@col = 0,
  'ALTER TABLE `clientaccount` ADD COLUMN `healthTrend28` INTEGER NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'clientaccount' AND COLUMN_NAME = 'healthComputedAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `clientaccount` ADD COLUMN `healthComputedAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'clientaccount' AND COLUMN_NAME = 'healthNote');
SET @sql := IF(@col = 0,
  'ALTER TABLE `clientaccount` ADD COLUMN `healthNote` VARCHAR(500) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'clientaccount' AND COLUMN_NAME = 'healthNoteById');
SET @sql := IF(@col = 0,
  'ALTER TABLE `clientaccount` ADD COLUMN `healthNoteById` VARCHAR(191) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'clientaccount' AND COLUMN_NAME = 'healthNoteAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `clientaccount` ADD COLUMN `healthNoteAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `healthscoredaily` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `date` VARCHAR(10) NOT NULL,
  `score` INTEGER NULL,
  `coverage` INTEGER NOT NULL DEFAULT 0,
  `profile` VARCHAR(16) NOT NULL,
  `configVersion` INTEGER NOT NULL,
  `pillars` JSON NOT NULL,
  `factors` JSON NOT NULL,
  `trend28` INTEGER NULL,
  `backfilled` BOOLEAN NOT NULL DEFAULT false,
  `computedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `healthscoredaily_projectId_date_key`(`projectId`, `date`),
  INDEX `healthscoredaily_date_idx`(`date`),
  PRIMARY KEY (`id`),
  CONSTRAINT `healthscoredaily_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `clienthealthdaily` (
  `id` VARCHAR(191) NOT NULL,
  `clientId` VARCHAR(191) NOT NULL,
  `date` VARCHAR(10) NOT NULL,
  `score` INTEGER NULL,
  `coverage` INTEGER NOT NULL DEFAULT 0,
  `pillars` JSON NOT NULL,
  `projectWeights` JSON NOT NULL,
  `configVersion` INTEGER NOT NULL,
  `trend28` INTEGER NULL,
  `computedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `clienthealthdaily_clientId_date_key`(`clientId`, `date`),
  INDEX `clienthealthdaily_date_idx`(`date`),
  PRIMARY KEY (`id`),
  CONSTRAINT `clienthealthdaily_clientId_fkey` FOREIGN KEY (`clientId`) REFERENCES `clientaccount`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `healthscoreconfig` (
  `id` VARCHAR(191) NOT NULL,
  `version` INTEGER NOT NULL,
  `config` JSON NOT NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT false,
  `note` VARCHAR(500) NULL,
  `createdById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `healthscoreconfig_version_key`(`version`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `healthalertlog` (
  `id` VARCHAR(191) NOT NULL,
  `clientId` VARCHAR(191) NOT NULL,
  `alertKey` VARCHAR(191) NOT NULL,
  `sentAt` DATETIME(3) NOT NULL,
  `count` INTEGER NOT NULL DEFAULT 1,
  UNIQUE INDEX `healthalertlog_clientId_alertKey_key`(`clientId`, `alertKey`),
  PRIMARY KEY (`id`),
  CONSTRAINT `healthalertlog_clientId_fkey` FOREIGN KEY (`clientId`) REFERENCES `clientaccount`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `keywordrankdaily` (
  `id` VARCHAR(191) NOT NULL,
  `keywordId` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `date` DATE NOT NULL,
  `rank` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `keywordrankdaily_keywordId_date_key`(`keywordId`, `date`),
  INDEX `keywordrankdaily_projectId_date_idx`(`projectId`, `date`),
  PRIMARY KEY (`id`),
  CONSTRAINT `keywordrankdaily_keywordId_fkey` FOREIGN KEY (`keywordId`) REFERENCES `keywordtrack`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `keywordrankdaily_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `llmreferraldaily` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `date` DATE NOT NULL,
  `platform` VARCHAR(40) NOT NULL,
  `sessions` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `llmreferraldaily_projectId_date_platform_key`(`projectId`, `date`, `platform`),
  INDEX `llmreferraldaily_projectId_date_idx`(`projectId`, `date`),
  PRIMARY KEY (`id`),
  CONSTRAINT `llmreferraldaily_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── Config version 1 (src/lib/health/defaultConfig.js DEFAULT_CONFIG_V1; seed-health-config.cjs seeds the same row) ──
INSERT IGNORE INTO `healthscoreconfig` (`id`, `version`, `config`, `isActive`, `note`, `createdAt`)
VALUES (UUID(), 1, '{"version":1,"window":{"days":28,"gscLagDays":2,"yoyMinCoverageDays":20},"minCoverage":40,"minPillars":2,"factorFloor":10,"pillarFloor":5,"blend":{"trend":0.6,"level":0.4},"trendK":25,"yoyShare":0.5,"profiles":{"SEO":{"visibility":25,"engagement":10,"leads":20,"reputation":15,"aiVisibility":10,"site":15,"content":5},"LOCAL":{"visibility":20,"engagement":10,"leads":20,"reputation":25,"aiVisibility":5,"site":15,"content":5},"AEO":{"visibility":20,"engagement":10,"leads":15,"reputation":10,"aiVisibility":30,"site":10,"content":5},"WEBSITE":{"visibility":15,"engagement":15,"leads":25,"reputation":0,"aiVisibility":0,"site":40,"content":5}},"factors":{"V1":{"pillar":"visibility","weight":1,"minPrior":50},"V2":{"pillar":"visibility","weight":1,"minPrior":500},"V3":{"pillar":"visibility","weight":1,"level":[[8,100],[20,60],[40,20]],"minImpr":200},"V4":{"pillar":"visibility","weight":1,"expectedA":0.3,"expectedB":-0.8,"gain":70,"minImpr":200},"E1":{"pillar":"engagement","weight":1,"minPrior":100,"shortWindowUntilDays":56},"E2":{"pillar":"engagement","weight":1,"level":[[20,20],[60,70],[120,100]],"minSessions":50},"E3":{"pillar":"engagement","weight":1,"level":[[35,100],[60,60],[85,15]],"minSessions":50},"L1":{"pillar":"leads","weight":1,"minPrior":10},"L2":{"pillar":"leads","weight":1,"level":[[0.5,20],[2,70],[5,100]],"minSessions":100},"L3":{"pillar":"leads","weight":1,"minPrior":10},"R1":{"pillar":"reputation","weight":1,"level":[[3.5,10],[4.2,60],[4.7,100]],"lastN":90,"minReviews":3},"R2":{"pillar":"reputation","weight":1,"minPrior":3,"level":[[0,30],[4,100]]},"R3":{"pillar":"reputation","weight":1,"level":[[0,20],[50,60],[90,100]],"days":90,"minReviews":3},"R4":{"pillar":"reputation","weight":1,"minPrior":20},"S1":{"pillar":"site","weight":1,"states":{"ok":100,"warn":60,"fail":25}},"S2":{"pillar":"site","weight":1,"days":14,"scores":{"okVerified":100,"ok":85,"miss1":50,"miss2plus":15}},"S3":{"pillar":"site","weight":1,"ageDays":[[1,100],[3,70],[7,40]],"beyond":15}},"bands":[[80,"excellent"],[60,"healthy"],[40,"at_risk"],[0,"critical"]],"trendArrowDelta":3,"alerts":{"sustainedDropPoints":10,"sustainedDays":7,"consecutiveRuns":2,"dedupeDays":7,"minCoverage":60}}', 1, 'v1 defaults', NOW(3));

-- ── Notification template (category `client`; seed-notifications.js seeds the same row) ──
INSERT IGNORE INTO `notificationtemplate`
  (`id`, `slug`, `name`, `description`, `category`, `subject`, `bodyHtml`, `bodyText`, `inAppMessage`, `variables`, `isActive`, `emailAgencyOwner`, `emailPm`, `emailClientManager`, `emailClientViewer`, `createdAt`, `updatedAt`)
VALUES
  (UUID(), 'health_score_drop', 'Client Health Drop', 'A client''s health score fell into a lower band, or dropped 10+ points over 7 days two runs in a row', 'client',
   'Health alert: {{clientName}} is now {{band}} ({{score}})',
   '<p>The health score of <strong>{{clientName}}</strong> is now <strong>{{score}}</strong> ({{band}}, {{delta}} points).</p><p>{{reasons}}</p><p>Open the client''s Health section for the full breakdown.</p>',
   'The health score of {{clientName}} is now {{score}} ({{band}}, {{delta}} points). {{reasons}} Open the client''s Health section for the full breakdown.',
   '{{clientName}} health: {{band}} ({{score}}, {{delta}})',
   JSON_ARRAY('clientName','score','band','delta','reasons','actionUrl'), 1, 1, 1, 0, 0, NOW(3), NOW(3));

-- The task-based v1 health alert is retired (its route is gone). Kept as a row so old logs keep their slug.
UPDATE `notificationtemplate` SET `isActive` = 0 WHERE `slug` = 'client_health_critical';
