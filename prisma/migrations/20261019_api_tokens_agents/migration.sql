-- SEO Engine agents, stage 1 (OS-01/02/04): User.isAgent + per-user API tokens.
-- Idempotent and additive only: the column is added behind an information_schema
-- check and the table uses CREATE TABLE IF NOT EXISTS. Nothing is dropped or retyped.

SET @db := DATABASE();

-- ── user.isAgent (server-side only flag, never sent to clients) ──────────────
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'user' AND COLUMN_NAME = 'isAgent');
SET @sql := IF(@col = 0,
  'ALTER TABLE `user` ADD COLUMN `isAgent` BOOLEAN NOT NULL DEFAULT false',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── apitoken: hashed lwk_ bearer tokens ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS `apitoken` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `tokenHash` VARCHAR(64) NOT NULL,
  `tokenPrefix` VARCHAR(16) NOT NULL,
  `scopes` JSON NULL,
  `projectIds` JSON NULL,
  `userTokenVersion` INTEGER NOT NULL DEFAULT 0,
  `expiresAt` DATETIME(3) NOT NULL,
  `lastUsedAt` DATETIME(3) NULL,
  `revokedAt` DATETIME(3) NULL,
  `revokedById` VARCHAR(191) NULL,
  `createdById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `apitoken_tokenHash_key`(`tokenHash`),
  INDEX `apitoken_userId_idx`(`userId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `apitoken_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
