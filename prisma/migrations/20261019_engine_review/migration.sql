-- SEO Engine exact-result review issuer (OS-11..14). Reviewed source: the Engine's localwaves-review bundle
-- migration.sql, adapted to this repo's conventions: CREATE TABLE IF NOT EXISTS, VARCHAR(191) ids, named indexes,
-- plus outbox columns for the pull-only delivery (osProjectId, expiresAt, ackedAt, ackedById).
-- Additive only. No FKs to task/taskcomment on purpose (frozen copies must survive edits/deletes); retention is
-- handled by lib/engineReview/retention.js (see docs/ledger/features/engine-agents.md).

CREATE TABLE IF NOT EXISTS `engine_review_frozen_result` (
  `id` VARCHAR(191) NOT NULL,
  `taskId` VARCHAR(191) NOT NULL,
  `commentId` VARCHAR(191) NOT NULL,
  `reportHash` CHAR(64) NOT NULL,
  `data` LONGTEXT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `engine_review_frozen_result_commentId_key`(`commentId`),
  INDEX `engine_review_frozen_result_taskId_idx`(`taskId`),
  INDEX `engine_review_frozen_result_createdAt_idx`(`createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `engine_review_task_head` (
  `taskId` VARCHAR(191) NOT NULL,
  `resultId` VARCHAR(191) NOT NULL,
  `version` INTEGER NOT NULL,
  `state` VARCHAR(30) NOT NULL,
  PRIMARY KEY (`taskId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `engine_review_challenge` (
  `id` VARCHAR(191) NOT NULL,
  `taskId` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `consumed` BOOLEAN NOT NULL DEFAULT false,
  `data` LONGTEXT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `engine_review_challenge_taskId_idx`(`taskId`),
  INDEX `engine_review_challenge_createdAt_idx`(`createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `engine_review_outbox` (
  `eventId` VARCHAR(191) NOT NULL,
  `challengeId` VARCHAR(191) NOT NULL,
  `taskId` VARCHAR(191) NOT NULL,
  `osProjectId` VARCHAR(191) NULL,
  `resultId` VARCHAR(191) NOT NULL,
  `version` INTEGER NOT NULL,
  `data` LONGTEXT NOT NULL,
  `expiresAt` DATETIME(3) NULL,
  `ackedAt` DATETIME(3) NULL,
  `ackedById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `engine_review_outbox_challengeId_key`(`challengeId`),
  INDEX `engine_review_outbox_createdAt_idx`(`createdAt`),
  INDEX `engine_review_outbox_osProjectId_idx`(`osProjectId`),
  UNIQUE INDEX `engine_review_outbox_taskId_resultId_version_key`(`taskId`, `resultId`, `version`),
  PRIMARY KEY (`eventId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
