-- Bing Webmaster Tools integration, Phases 1 + 2 and the DataForSEO Bing rank table (docs/ledger/features/bing-webmaster.md).
-- Additive and idempotent: information_schema check + PREPARE per column, CREATE TABLE IF NOT EXISTS with inline FKs,
-- a guarded INSERT for the health config proposal. Nothing dropped, renamed or retyped.
-- The DDL matches `prisma migrate diff --from-schema-datamodel <main schema> --to-schema-datamodel <branch schema>`.
-- Independent of 20261113_mcp_server (parallel branch); no shared tables.

SET @db := DATABASE();

-- ── project: Bing site binding + sync status + Bing Places checklist ──
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'bingSiteUrl');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `bingSiteUrl` VARCHAR(500) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'bingLastSyncedAt');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `bingLastSyncedAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'bingSyncError');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `bingSyncError` VARCHAR(500) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'bingPlacesUrl');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `bingPlacesUrl` VARCHAR(500) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'bingPlacesClaimed');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `bingPlacesClaimed` BOOLEAN NOT NULL DEFAULT false', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'bingPlacesCheckedAt');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `bingPlacesCheckedAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── agencybingconnection (credential columns never leave the API: lib/redactSecrets.js DROP_KEYS) ──
CREATE TABLE IF NOT EXISTS `agencybingconnection` (
  `id` VARCHAR(191) NOT NULL,
  `authType` VARCHAR(10) NOT NULL DEFAULT 'api_key',
  `apiKeyEnc` TEXT NULL,
  `refreshTokenEnc` TEXT NULL,
  `accessTokenEnc` TEXT NULL,
  `accessTokenExpiresAt` DATETIME(3) NULL,
  `scopes` VARCHAR(255) NULL,
  `accountLabel` VARCHAR(255) NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  `connectedById` VARCHAR(191) NULL,
  `connectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lastOkAt` DATETIME(3) NULL,
  `lastError` VARCHAR(500) NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `agencybingconnection_connectedById_fkey` FOREIGN KEY (`connectedById`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── bingdailymetric (GetRankAndTrafficStats, 400-day retention) ──
CREATE TABLE IF NOT EXISTS `bingdailymetric` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `date` DATE NOT NULL,
  `clicks` INTEGER NOT NULL DEFAULT 0,
  `impressions` INTEGER NOT NULL DEFAULT 0,
  `ctr` DOUBLE NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `bingdailymetric_projectId_date_key`(`projectId`, `date`),
  PRIMARY KEY (`id`),
  CONSTRAINT `bingdailymetric_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── bingcrawldaily (GetCrawlStats, 400-day retention) ──
CREATE TABLE IF NOT EXISTS `bingcrawldaily` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `date` DATE NOT NULL,
  `crawledPages` INTEGER NULL,
  `inIndex` INTEGER NULL,
  `inLinks` INTEGER NULL,
  `code2xx` INTEGER NULL,
  `code301` INTEGER NULL,
  `code302` INTEGER NULL,
  `code4xx` INTEGER NULL,
  `code5xx` INTEGER NULL,
  `allOtherCodes` INTEGER NULL,
  `blockedByRobotsTxt` INTEGER NULL,
  `containsMalware` INTEGER NULL,
  `crawlErrors` INTEGER NULL,
  `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `bingcrawldaily_projectId_date_key`(`projectId`, `date`),
  PRIMARY KEY (`id`),
  CONSTRAINT `bingcrawldaily_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── bingqueryweekly (GetQueryStats, weekly buckets, 400-day retention) ──
CREATE TABLE IF NOT EXISTS `bingqueryweekly` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `weekStart` DATE NOT NULL,
  `query` VARCHAR(500) NOT NULL,
  `clicks` INTEGER NOT NULL DEFAULT 0,
  `impressions` INTEGER NOT NULL DEFAULT 0,
  `avgClickPosition` DOUBLE NULL,
  `avgImpressionPosition` DOUBLE NULL,
  `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `bingqueryweekly_projectId_weekStart_idx`(`projectId`, `weekStart`),
  UNIQUE INDEX `bingqueryweekly_projectId_weekStart_query_key`(`projectId`, `weekStart`, `query`),
  PRIMARY KEY (`id`),
  CONSTRAINT `bingqueryweekly_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── bingpageweekly (GetPageStats, weekly buckets, 400-day retention) ──
CREATE TABLE IF NOT EXISTS `bingpageweekly` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `weekStart` DATE NOT NULL,
  `urlHash` CHAR(64) NOT NULL,
  `url` VARCHAR(1000) NOT NULL,
  `clicks` INTEGER NOT NULL DEFAULT 0,
  `impressions` INTEGER NOT NULL DEFAULT 0,
  `avgClickPosition` DOUBLE NULL,
  `avgImpressionPosition` DOUBLE NULL,
  `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `bingpageweekly_projectId_weekStart_idx`(`projectId`, `weekStart`),
  UNIQUE INDEX `bingpageweekly_projectId_weekStart_urlHash_key`(`projectId`, `weekStart`, `urlHash`),
  PRIMARY KEY (`id`),
  CONSTRAINT `bingpageweekly_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── bingcrawlissue (GetCrawlIssues diff; resolved rows purged after 90 days) ──
CREATE TABLE IF NOT EXISTS `bingcrawlissue` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `urlHash` CHAR(64) NOT NULL,
  `url` VARCHAR(1000) NOT NULL,
  `httpCode` INTEGER NULL,
  `issuesRaw` INTEGER NOT NULL DEFAULT 0,
  `issues` JSON NULL,
  `inLinks` INTEGER NULL,
  `firstSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `resolvedAt` DATETIME(3) NULL,
  INDEX `bingcrawlissue_projectId_resolvedAt_idx`(`projectId`, `resolvedAt`),
  UNIQUE INDEX `bingcrawlissue_projectId_urlHash_key`(`projectId`, `urlHash`),
  PRIMARY KEY (`id`),
  CONSTRAINT `bingcrawlissue_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── bingsitestate (1:1 sync state, staff only) ──
CREATE TABLE IF NOT EXISTS `bingsitestate` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `isVerified` BOOLEAN NULL,
  `lastTrafficAt` DATETIME(3) NULL,
  `lastCrawlAt` DATETIME(3) NULL,
  `lastQueriesAt` DATETIME(3) NULL,
  `lastIssuesAt` DATETIME(3) NULL,
  `errorCode` VARCHAR(40) NULL,
  `errorAt` DATETIME(3) NULL,
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `bingsitestate_projectId_key`(`projectId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `bingsitestate_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── bingserprankdaily (paid DataForSEO Bing SERP, BING_RANK_ENABLED default off; costUsd staff only) ──
CREATE TABLE IF NOT EXISTS `bingserprankdaily` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `keywordId` VARCHAR(191) NOT NULL,
  `date` DATE NOT NULL,
  `organicRank` INTEGER NULL,
  `organicUrl` VARCHAR(1000) NULL,
  `localPackRank` INTEGER NULL,
  `localPackPresent` BOOLEAN NOT NULL DEFAULT false,
  `matchedBy` VARCHAR(16) NULL,
  `depth` INTEGER NULL,
  `costUsd` DECIMAL(10, 5) NULL,
  `status` VARCHAR(12) NOT NULL,
  `errorCode` VARCHAR(40) NULL,
  `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `bingserprankdaily_projectId_date_idx`(`projectId`, `date`),
  UNIQUE INDEX `bingserprankdaily_keywordId_date_key`(`keywordId`, `date`),
  PRIMARY KEY (`id`),
  CONSTRAINT `bingserprankdaily_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `bingserprankdaily_keywordId_fkey` FOREIGN KEY (`keywordId`) REFERENCES `keywordtrack`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── Health score config v3 PROPOSAL (V5 Bing clicks, S4 Bing crawl health); same JSON as DEFAULT_CONFIG_V3 ──
-- Stored as the next free version and NOT activated: the owner approves the weights and activates it from the Health
-- config card. Inserted once (keyed by its note); an existing owner-edited version 3 is never touched.
SET @have := (SELECT COUNT(*) FROM `healthscoreconfig` WHERE `note` = 'v3 proposal (V5 Bing clicks, S4 Bing crawl health), weights 0.5, owner approval needed');
SET @next := (SELECT COALESCE(MAX(`version`), 0) + 1 FROM `healthscoreconfig`);
INSERT INTO `healthscoreconfig` (`id`, `version`, `config`, `isActive`, `note`, `createdAt`)
SELECT UUID(), @next, '{"version":3,"window":{"days":28,"gscLagDays":2,"yoyMinCoverageDays":20},"minCoverage":40,"minPillars":2,"factorFloor":10,"pillarFloor":5,"blend":{"trend":0.6,"level":0.4},"trendK":25,"yoyShare":0.5,"profiles":{"SEO":{"visibility":25,"engagement":10,"leads":20,"reputation":15,"aiVisibility":10,"site":15,"content":5},"LOCAL":{"visibility":20,"engagement":10,"leads":20,"reputation":25,"aiVisibility":5,"site":15,"content":5},"AEO":{"visibility":20,"engagement":10,"leads":15,"reputation":10,"aiVisibility":30,"site":10,"content":5},"WEBSITE":{"visibility":15,"engagement":15,"leads":25,"reputation":0,"aiVisibility":0,"site":40,"content":5}},"factors":{"V1":{"pillar":"visibility","weight":1,"minPrior":50},"V2":{"pillar":"visibility","weight":1,"minPrior":500},"V3":{"pillar":"visibility","weight":1,"level":[[8,100],[20,60],[40,20]],"minImpr":200},"V4":{"pillar":"visibility","weight":1,"expectedA":0.3,"expectedB":-0.8,"gain":70,"minImpr":200},"E1":{"pillar":"engagement","weight":1,"minPrior":100,"shortWindowUntilDays":56},"E2":{"pillar":"engagement","weight":1,"level":[[20,20],[60,70],[120,100]],"minSessions":50},"E3":{"pillar":"engagement","weight":1,"level":[[35,100],[60,60],[85,15]],"minSessions":50},"L1":{"pillar":"leads","weight":1,"minPrior":10},"L2":{"pillar":"leads","weight":1,"level":[[0.5,20],[2,70],[5,100]],"minSessions":100},"L3":{"pillar":"leads","weight":1,"minPrior":10},"R1":{"pillar":"reputation","weight":1,"level":[[3.5,10],[4.2,60],[4.7,100]],"lastN":90,"minReviews":3},"R2":{"pillar":"reputation","weight":1,"minPrior":3,"level":[[0,30],[4,100]]},"R3":{"pillar":"reputation","weight":1,"level":[[0,20],[50,60],[90,100]],"days":90,"minReviews":3},"R4":{"pillar":"reputation","weight":1,"minPrior":20},"S1":{"pillar":"site","weight":1,"states":{"ok":100,"warn":60,"fail":25}},"S2":{"pillar":"site","weight":1,"days":14,"scores":{"okVerified":100,"ok":85,"miss1":50,"miss2plus":15}},"S3":{"pillar":"site","weight":1,"ageDays":[[1,100],[3,70],[7,40]],"beyond":15},"R5":{"pillar":"reputation","weight":1,"level":[[50,20],[80,60],[100,100]],"minChecked":3},"A1":{"pillar":"aiVisibility","weight":1,"level":[[0,15],[25,60],[60,100]],"maxAgeDays":45,"minCells":5},"V5":{"pillar":"visibility","weight":0.5,"minPrior":20},"S4":{"pillar":"site","weight":0.5,"level":[[0,100],[2,70],[10,20]],"days":7,"minCrawled":50}},"bands":[[80,"excellent"],[60,"healthy"],[40,"at_risk"],[0,"critical"]],"trendArrowDelta":3,"alerts":{"sustainedDropPoints":10,"sustainedDays":7,"consecutiveRuns":2,"dedupeDays":7,"minCoverage":60}}', 0, 'v3 proposal (V5 Bing clicks, S4 Bing crawl health), weights 0.5, owner approval needed', NOW(3)
FROM DUAL WHERE @have = 0;
