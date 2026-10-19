-- SEO Engine Google token broker audit (OS-16). Additive only: one new table, no FKs (audit rows outlive tokens and
-- projects). The issued Google access token itself is never stored. Retention: 365 days (hourly leader purge).

CREATE TABLE IF NOT EXISTS `googletokenissuance` (
  `id` VARCHAR(191) NOT NULL,
  `apiTokenId` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `product` VARCHAR(16) NOT NULL,
  `property` VARCHAR(500) NOT NULL,
  `scope` VARCHAR(255) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `ip` VARCHAR(45) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `googletokenissuance_projectId_createdAt_idx`(`projectId`, `createdAt`),
  INDEX `googletokenissuance_apiTokenId_createdAt_idx`(`apiTokenId`, `createdAt`),
  INDEX `googletokenissuance_createdAt_idx`(`createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
