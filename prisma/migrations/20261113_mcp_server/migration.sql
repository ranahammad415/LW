-- Remote MCP server (docs/ledger/features/mcp-server.md): OAuth 2.1 clients / auth requests / grants / tokens, dangerous
-- action confirmations, MCP audit log, and the OWNER "Pause MCP" switch on agency_setting.
-- Additive and idempotent: CREATE TABLE IF NOT EXISTS with inline FKs, information_schema check + PREPARE per column.
-- Nothing dropped, renamed or retyped. Order: parents before children (mcpclient → mcpgrant → mcptoken / mcpauthrequest).
-- The DDL matches `prisma migrate diff --from-schema-datamodel <main schema> --to-schema-datamodel <branch schema>`.

SET @db := DATABASE();

-- ── mcpclient (dynamic client registration) ──
CREATE TABLE IF NOT EXISTS `mcpclient` (
  `id` VARCHAR(191) NOT NULL,
  `clientName` VARCHAR(100) NOT NULL,
  `redirectUris` JSON NOT NULL,
  `tokenEndpointAuthMethod` VARCHAR(32) NOT NULL DEFAULT 'none',
  `clientSecretHash` VARCHAR(64) NULL,
  `grantTypes` JSON NOT NULL,
  `responseTypes` JSON NOT NULL,
  `scope` VARCHAR(100) NULL,
  `clientUri` VARCHAR(500) NULL,
  `logoUri` VARCHAR(500) NULL,
  `softwareId` VARCHAR(100) NULL,
  `softwareVersion` VARCHAR(50) NULL,
  `registrationIp` VARCHAR(64) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lastUsedAt` DATETIME(3) NULL,
  `disabledAt` DATETIME(3) NULL,
  `disabledById` VARCHAR(191) NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── mcpgrant (one user's consent for one client) ──
CREATE TABLE IF NOT EXISTS `mcpgrant` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `clientId` VARCHAR(191) NOT NULL,
  `scope` VARCHAR(100) NOT NULL,
  `userTokenVersion` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lastUsedAt` DATETIME(3) NULL,
  `revokedAt` DATETIME(3) NULL,
  `revokedById` VARCHAR(191) NULL,
  `revokedReason` VARCHAR(64) NULL,
  INDEX `mcpgrant_userId_idx`(`userId`),
  INDEX `mcpgrant_clientId_idx`(`clientId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `mcpgrant_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `mcpgrant_clientId_fkey` FOREIGN KEY (`clientId`) REFERENCES `mcpclient`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── mcptoken (access mcpa_ / refresh mcpr_; sha256 only) ──
CREATE TABLE IF NOT EXISTS `mcptoken` (
  `id` VARCHAR(191) NOT NULL,
  `grantId` VARCHAR(191) NOT NULL,
  `kind` VARCHAR(8) NOT NULL,
  `tokenHash` VARCHAR(64) NOT NULL,
  `prefix` VARCHAR(12) NOT NULL,
  `familyId` VARCHAR(191) NOT NULL,
  `parentId` VARCHAR(191) NULL,
  `resource` VARCHAR(500) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `usedAt` DATETIME(3) NULL,
  `revokedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `mcptoken_tokenHash_key`(`tokenHash`),
  INDEX `mcptoken_grantId_kind_idx`(`grantId`, `kind`),
  INDEX `mcptoken_familyId_idx`(`familyId`),
  INDEX `mcptoken_expiresAt_idx`(`expiresAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `mcptoken_grantId_fkey` FOREIGN KEY (`grantId`) REFERENCES `mcpgrant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── mcpauthrequest (10-minute /authorize attempts; code sha256 only) ──
CREATE TABLE IF NOT EXISTS `mcpauthrequest` (
  `id` VARCHAR(191) NOT NULL,
  `clientId` VARCHAR(191) NOT NULL,
  `redirectUri` VARCHAR(500) NOT NULL,
  `state` VARCHAR(1024) NULL,
  `scope` VARCHAR(100) NOT NULL,
  `resource` VARCHAR(500) NOT NULL,
  `codeChallenge` VARCHAR(128) NOT NULL,
  `codeChallengeMethod` VARCHAR(8) NOT NULL DEFAULT 'S256',
  `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
  `userId` VARCHAR(191) NULL,
  `codeHash` VARCHAR(64) NULL,
  `codeExpiresAt` DATETIME(3) NULL,
  `grantId` VARCHAR(191) NULL,
  `ip` VARCHAR(64) NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `mcpauthrequest_codeHash_key`(`codeHash`),
  INDEX `mcpauthrequest_clientId_idx`(`clientId`),
  INDEX `mcpauthrequest_expiresAt_idx`(`expiresAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `mcpauthrequest_clientId_fkey` FOREIGN KEY (`clientId`) REFERENCES `mcpclient`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── mcpconfirmation (no FKs on purpose) ──
CREATE TABLE IF NOT EXISTS `mcpconfirmation` (
  `id` VARCHAR(191) NOT NULL,
  `grantId` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `tool` VARCHAR(64) NOT NULL,
  `routeKey` VARCHAR(200) NULL,
  `argsHash` VARCHAR(64) NOT NULL,
  `args` JSON NOT NULL,
  `preview` JSON NOT NULL,
  `tokenHash` VARCHAR(64) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `consumedAt` DATETIME(3) NULL,
  `level` VARCHAR(16) NOT NULL DEFAULT 'dangerous',
  `approvedAt` DATETIME(3) NULL,
  `approvedById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `mcpconfirmation_tokenHash_key`(`tokenHash`),
  INDEX `mcpconfirmation_expiresAt_idx`(`expiresAt`),
  INDEX `mcpconfirmation_userId_createdAt_idx`(`userId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Critical-action approval columns (security review M3). In the CREATE above for fresh databases; added here for a
-- database that already ran an earlier copy of this branch's migration.
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'mcpconfirmation' AND COLUMN_NAME = 'level');
SET @sql := IF(@col = 0, 'ALTER TABLE `mcpconfirmation` ADD COLUMN `level` VARCHAR(16) NOT NULL DEFAULT ''dangerous''', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'mcpconfirmation' AND COLUMN_NAME = 'approvedAt');
SET @sql := IF(@col = 0, 'ALTER TABLE `mcpconfirmation` ADD COLUMN `approvedAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'mcpconfirmation' AND COLUMN_NAME = 'approvedById');
SET @sql := IF(@col = 0, 'ALTER TABLE `mcpconfirmation` ADD COLUMN `approvedById` VARCHAR(191) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── mcpauditlog (no FKs on purpose; retention MCP_AUDIT_RETENTION_DAYS) ──
CREATE TABLE IF NOT EXISTS `mcpauditlog` (
  `id` VARCHAR(191) NOT NULL,
  `grantId` VARCHAR(191) NULL,
  `userId` VARCHAR(191) NOT NULL,
  `clientId` VARCHAR(191) NULL,
  `tool` VARCHAR(64) NOT NULL,
  `routeMethod` VARCHAR(8) NULL,
  `routePattern` VARCHAR(200) NULL,
  `path` VARCHAR(500) NULL,
  `argsSummary` JSON NULL,
  `danger` VARCHAR(16) NOT NULL,
  `confirmed` BOOLEAN NOT NULL DEFAULT false,
  `confirmationId` VARCHAR(191) NULL,
  `statusCode` INTEGER NULL,
  `ok` BOOLEAN NOT NULL,
  `errorCode` VARCHAR(64) NULL,
  `durationMs` INTEGER NOT NULL DEFAULT 0,
  `resultBytes` INTEGER NOT NULL DEFAULT 0,
  `truncated` BOOLEAN NOT NULL DEFAULT false,
  `ip` VARCHAR(64) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `mcpauditlog_userId_createdAt_idx`(`userId`, `createdAt`),
  INDEX `mcpauditlog_grantId_createdAt_idx`(`grantId`, `createdAt`),
  INDEX `mcpauditlog_createdAt_idx`(`createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── agency_setting: OWNER "Pause MCP" switch ──
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'agency_setting' AND COLUMN_NAME = 'mcpPausedAt');
SET @sql := IF(@col = 0, 'ALTER TABLE `agency_setting` ADD COLUMN `mcpPausedAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'agency_setting' AND COLUMN_NAME = 'mcpPausedById');
SET @sql := IF(@col = 0, 'ALTER TABLE `agency_setting` ADD COLUMN `mcpPausedById` VARCHAR(191) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
