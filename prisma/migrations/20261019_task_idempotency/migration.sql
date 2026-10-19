-- SEO Engine agents, stage 2 (OS-05/07): Task.completedAt + Idempotency-Key records.
-- Idempotent and additive only. Existing COMPLETED tasks keep completedAt NULL (no reliable completion time to
-- backfill; updatedAt is not a completion time). Nothing is dropped or retyped.

SET @db := DATABASE();

-- ── task.completedAt ─────────────────────────────────────────────────────────
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'task' AND COLUMN_NAME = 'completedAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `task` ADD COLUMN `completedAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── idempotencykey ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `idempotencykey` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `route` VARCHAR(100) NOT NULL,
  `key` VARCHAR(255) NOT NULL,
  `requestHash` VARCHAR(64) NOT NULL,
  `state` VARCHAR(16) NOT NULL DEFAULT 'pending',
  `statusCode` INTEGER NULL,
  `responseBody` LONGTEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expiresAt` DATETIME(3) NOT NULL,
  INDEX `idempotencykey_expiresAt_idx`(`expiresAt`),
  UNIQUE INDEX `idempotencykey_userId_route_key_key`(`userId`, `route`, `key`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
