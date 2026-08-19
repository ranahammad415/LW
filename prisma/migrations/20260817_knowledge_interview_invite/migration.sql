-- Tokenised, login-free links for client knowledge interviews. Mirrors the
-- password_reset_token pattern: only the sha256 of the token is stored.

CREATE TABLE IF NOT EXISTS `knowledgeinterviewinvite` (
  `id` VARCHAR(191) NOT NULL,
  `clientId` VARCHAR(255) NOT NULL,
  `projectId` VARCHAR(255) NULL,
  `tokenHash` VARCHAR(64) NOT NULL,
  `createdById` VARCHAR(255) NULL,
  `recipientName` VARCHAR(255) NULL,
  `sentToEmail` VARCHAR(255) NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  `expiresAt` DATETIME(3) NOT NULL,
  `lastOpenedAt` DATETIME(3) NULL,
  `completedAt` DATETIME(3) NULL,
  `revokedAt` DATETIME(3) NULL,
  `draftData` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `knowledgeinterviewinvite_tokenHash_key` (`tokenHash`),
  INDEX `knowledgeinterviewinvite_clientId_createdAt_idx` (`clientId`, `createdAt`),
  INDEX `knowledgeinterviewinvite_expiresAt_idx` (`expiresAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
