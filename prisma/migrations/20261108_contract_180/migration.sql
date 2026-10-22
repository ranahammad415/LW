-- EmDash contract 1.8.0 (§39 citations / NAP monitoring, AI-visibility prompt set) and the Maps standard queue
-- (docs/ledger/emdash-bridge.md §v1.8.0, features/local-seo.md, features/health-score.md).
-- Additive and idempotent: information_schema check + PREPARE per column / index / foreign key, CREATE TABLE IF NOT
-- EXISTS, INSERT IGNORE. Nothing dropped, renamed or retyped. Health config: version 2 is inserted (version 1 is never
-- touched) and made active only while version 1 is the active version (an OWNER-edited config stays active).

SET @db := DATABASE();

-- ── aivisibilityrun ──
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'aivisibilityrun' AND COLUMN_NAME = 'source');
SET @sql := IF(@col = 0, 'ALTER TABLE `aivisibilityrun` ADD COLUMN `source` VARCHAR(16) NOT NULL DEFAULT ''admin''', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'aivisibilityrun' AND COLUMN_NAME = 'period');
SET @sql := IF(@col = 0, 'ALTER TABLE `aivisibilityrun` ADD COLUMN `period` VARCHAR(7) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'aivisibilityrun' AND COLUMN_NAME = 'costUsd');
SET @sql := IF(@col = 0, 'ALTER TABLE `aivisibilityrun` ADD COLUMN `costUsd` DECIMAL(10, 5) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- One scheduled run per project per month (admin runs keep period NULL; MySQL allows many NULLs in a unique index).
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'aivisibilityrun' AND INDEX_NAME = 'aivisibilityrun_projectId_period_key');
SET @sql := IF(@idx = 0, 'CREATE UNIQUE INDEX `aivisibilityrun_projectId_period_key` ON `aivisibilityrun`(`projectId`, `period`)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── aivisibilityresult ──
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'aivisibilityresult' AND COLUMN_NAME = 'promptId');
SET @sql := IF(@col = 0, 'ALTER TABLE `aivisibilityresult` ADD COLUMN `promptId` VARCHAR(120) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'aivisibilityresult' AND COLUMN_NAME = 'town');
SET @sql := IF(@col = 0, 'ALTER TABLE `aivisibilityresult` ADD COLUMN `town` VARCHAR(100) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'aivisibilityresult' AND COLUMN_NAME = 'service');
SET @sql := IF(@col = 0, 'ALTER TABLE `aivisibilityresult` ADD COLUMN `service` VARCHAR(200) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'aivisibilityresult' AND COLUMN_NAME = 'branded');
SET @sql := IF(@col = 0, 'ALTER TABLE `aivisibilityresult` ADD COLUMN `branded` BOOLEAN NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'aivisibilityresult' AND COLUMN_NAME = 'mentionPosition');
SET @sql := IF(@col = 0, 'ALTER TABLE `aivisibilityresult` ADD COLUMN `mentionPosition` INTEGER NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'aivisibilityresult' AND COLUMN_NAME = 'costUsd');
SET @sql := IF(@col = 0, 'ALTER TABLE `aivisibilityresult` ADD COLUMN `costUsd` DECIMAL(10, 6) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── localranktask (Maps standard queue) ──
CREATE TABLE IF NOT EXISTS `localranktask` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `keywordId` VARCHAR(191) NOT NULL,
  `kind` VARCHAR(8) NOT NULL,
  `date` DATE NOT NULL,
  `gridId` VARCHAR(191) NULL,
  `pointIndex` INTEGER NULL,
  `taskId` VARCHAR(64) NOT NULL,
  `locationMode` VARCHAR(16) NULL,
  `depth` INTEGER NULL,
  `status` VARCHAR(12) NOT NULL,
  `postedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `collectedAt` DATETIME(3) NULL,
  `polls` INTEGER NOT NULL DEFAULT 0,
  `costUsd` DECIMAL(10, 5) NULL,
  `errorCode` VARCHAR(40) NULL,
  UNIQUE INDEX `localranktask_taskId_key`(`taskId`),
  INDEX `localranktask_status_postedAt_idx`(`status`, `postedAt`),
  INDEX `localranktask_projectId_kind_date_idx`(`projectId`, `kind`, `date`),
  INDEX `localranktask_gridId_idx`(`gridId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `localranktask_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `localranktask_keywordId_fkey` FOREIGN KEY (`keywordId`) REFERENCES `keywordtrack`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── citations (contract 1.8.0 §39) ──
CREATE TABLE IF NOT EXISTS `seocitationmirror` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `siteCitationId` VARCHAR(100) NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `url` TEXT NULL,
  `kind` VARCHAR(16) NOT NULL,
  `listed` BOOLEAN NOT NULL DEFAULT false,
  `napStatus` VARCHAR(10) NOT NULL DEFAULT 'unknown',
  `nameSeen` VARCHAR(200) NULL,
  `phoneSeen` VARCHAR(200) NULL,
  `zipSeen` VARCHAR(200) NULL,
  `hoursSeen` VARCHAR(200) NULL,
  `checks` JSON NULL,
  `lastChecked` DATETIME(3) NULL,
  `checkedBy` VARCHAR(8) NOT NULL DEFAULT 'human',
  `note` TEXT NULL,
  `utm` VARCHAR(300) NULL,
  `rank` INTEGER NULL,
  `siteUpdatedAt` DATETIME(3) NULL,
  `rev` INTEGER NOT NULL DEFAULT 0,
  `lastOsCheckAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `seocitationmirror_projectId_napStatus_idx`(`projectId`, `napStatus`),
  UNIQUE INDEX `seocitationmirror_projectId_siteCitationId_key`(`projectId`, `siteCitationId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `seocitationmirror_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `seocitationstate` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `rev` INTEGER NULL,
  `stale` BOOLEAN NOT NULL DEFAULT false,
  `fetchedAt` DATETIME(3) NULL,
  `canonicalNap` JSON NULL,
  `canonicalNapById` VARCHAR(191) NULL,
  `canonicalNapAt` DATETIME(3) NULL,
  `lastMonitorAt` DATETIME(3) NULL,
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `seocitationstate_projectId_key`(`projectId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `seocitationstate_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `seocitationcheckrun` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `trigger` VARCHAR(12) NOT NULL,
  `requestedById` VARCHAR(191) NULL,
  `status` VARCHAR(12) NOT NULL,
  `period` VARCHAR(7) NULL,
  `dfsCalls` INTEGER NOT NULL DEFAULT 0,
  `pageFetches` INTEGER NOT NULL DEFAULT 0,
  `costUsd` DECIMAL(10, 5) NULL,
  `checked` INTEGER NOT NULL DEFAULT 0,
  `written` INTEGER NOT NULL DEFAULT 0,
  `results` JSON NULL,
  `warnings` JSON NULL,
  `errorCode` VARCHAR(40) NULL,
  `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `finishedAt` DATETIME(3) NULL,
  INDEX `seocitationcheckrun_projectId_startedAt_idx`(`projectId`, `startedAt`),
  UNIQUE INDEX `seocitationcheckrun_projectId_period_key`(`projectId`, `period`),
  PRIMARY KEY (`id`),
  CONSTRAINT `seocitationcheckrun_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── Health score config version 2 (R5 listings consistency, A1 AI citation rate); same JSON as DEFAULT_CONFIG_V2 ──
INSERT IGNORE INTO `healthscoreconfig` (`id`, `version`, `config`, `isActive`, `note`, `createdAt`)
VALUES (UUID(), 2, '{"version":2,"window":{"days":28,"gscLagDays":2,"yoyMinCoverageDays":20},"minCoverage":40,"minPillars":2,"factorFloor":10,"pillarFloor":5,"blend":{"trend":0.6,"level":0.4},"trendK":25,"yoyShare":0.5,"profiles":{"SEO":{"visibility":25,"engagement":10,"leads":20,"reputation":15,"aiVisibility":10,"site":15,"content":5},"LOCAL":{"visibility":20,"engagement":10,"leads":20,"reputation":25,"aiVisibility":5,"site":15,"content":5},"AEO":{"visibility":20,"engagement":10,"leads":15,"reputation":10,"aiVisibility":30,"site":10,"content":5},"WEBSITE":{"visibility":15,"engagement":15,"leads":25,"reputation":0,"aiVisibility":0,"site":40,"content":5}},"factors":{"V1":{"pillar":"visibility","weight":1,"minPrior":50},"V2":{"pillar":"visibility","weight":1,"minPrior":500},"V3":{"pillar":"visibility","weight":1,"level":[[8,100],[20,60],[40,20]],"minImpr":200},"V4":{"pillar":"visibility","weight":1,"expectedA":0.3,"expectedB":-0.8,"gain":70,"minImpr":200},"E1":{"pillar":"engagement","weight":1,"minPrior":100,"shortWindowUntilDays":56},"E2":{"pillar":"engagement","weight":1,"level":[[20,20],[60,70],[120,100]],"minSessions":50},"E3":{"pillar":"engagement","weight":1,"level":[[35,100],[60,60],[85,15]],"minSessions":50},"L1":{"pillar":"leads","weight":1,"minPrior":10},"L2":{"pillar":"leads","weight":1,"level":[[0.5,20],[2,70],[5,100]],"minSessions":100},"L3":{"pillar":"leads","weight":1,"minPrior":10},"R1":{"pillar":"reputation","weight":1,"level":[[3.5,10],[4.2,60],[4.7,100]],"lastN":90,"minReviews":3},"R2":{"pillar":"reputation","weight":1,"minPrior":3,"level":[[0,30],[4,100]]},"R3":{"pillar":"reputation","weight":1,"level":[[0,20],[50,60],[90,100]],"days":90,"minReviews":3},"R4":{"pillar":"reputation","weight":1,"minPrior":20},"S1":{"pillar":"site","weight":1,"states":{"ok":100,"warn":60,"fail":25}},"S2":{"pillar":"site","weight":1,"days":14,"scores":{"okVerified":100,"ok":85,"miss1":50,"miss2plus":15}},"S3":{"pillar":"site","weight":1,"ageDays":[[1,100],[3,70],[7,40]],"beyond":15},"R5":{"pillar":"reputation","weight":1,"level":[[50,20],[80,60],[100,100]],"minChecked":3},"A1":{"pillar":"aiVisibility","weight":1,"level":[[0,15],[25,60],[60,100]],"maxAgeDays":45,"minCells":5}},"bands":[[80,"excellent"],[60,"healthy"],[40,"at_risk"],[0,"critical"]],"trendArrowDelta":3,"alerts":{"sustainedDropPoints":10,"sustainedDays":7,"consecutiveRuns":2,"dedupeDays":7,"minCoverage":60}}', 0, 'v2 defaults (R5 listings consistency, A1 AI citation rate)', NOW(3));

-- Activate version 2 only when it is our row and version 1 (or nothing) is active. Re-runs change nothing.
SET @active := (SELECT MAX(`version`) FROM `healthscoreconfig` WHERE `isActive` = 1);
SET @ours := (SELECT COUNT(*) FROM `healthscoreconfig` WHERE `version` = 2 AND `note` = 'v2 defaults (R5 listings consistency, A1 AI citation rate)');
UPDATE `healthscoreconfig` SET `isActive` = (`version` = 2)
  WHERE @ours = 1 AND (@active IS NULL OR @active = 1) AND `version` IN (1, 2);
