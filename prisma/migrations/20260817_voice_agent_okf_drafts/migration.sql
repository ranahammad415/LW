-- Realtime voice business agent: interview sessions and the approval-gated
-- OKF draft queue that the SEO team reviews before anything is written.

CREATE TABLE IF NOT EXISTS `voiceinterviewsession` (
  `id` VARCHAR(191) NOT NULL,
  `clientId` VARCHAR(255) NOT NULL,
  `projectId` VARCHAR(255) NULL,
  `userId` VARCHAR(255) NOT NULL,
  `status` VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
  `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `endedAt` DATETIME(3) NULL,
  `durationSeconds` INT NOT NULL DEFAULT 0,
  `transcript` JSON NULL,
  `extractedData` JSON NULL,
  `summary` TEXT NULL,
  `model` VARCHAR(100) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `voiceinterviewsession_clientId_startedAt_idx` (`clientId`, `startedAt`),
  INDEX `voiceinterviewsession_userId_idx` (`userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `okfdraftchange` (
  `id` VARCHAR(191) NOT NULL,
  `clientId` VARCHAR(255) NOT NULL,
  `sessionId` VARCHAR(191) NULL,
  `folder` VARCHAR(255) NOT NULL,
  `filename` VARCHAR(255) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `proposedMetadata` JSON NULL,
  `proposedBody` LONGTEXT NOT NULL,
  `sourceType` VARCHAR(40) NOT NULL DEFAULT 'VOICE_AGENT',
  `confidence` DOUBLE NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  `reviewerId` VARCHAR(255) NULL,
  `reviewedAt` DATETIME(3) NULL,
  `reviewNote` VARCHAR(1000) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `okfdraftchange_clientId_status_idx` (`clientId`, `status`),
  INDEX `okfdraftchange_sessionId_idx` (`sessionId`),
  CONSTRAINT `okfdraftchange_sessionId_fkey`
    FOREIGN KEY (`sessionId`) REFERENCES `voiceinterviewsession`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Expose the voice agent through the modality system so it can be switched off
-- per role (it is materially more expensive per minute than Whisper + TTS).
INSERT INTO `modality_config` (`id`, `featureKey`, `role`, `enabled`, `createdAt`, `updatedAt`)
VALUES
  (UUID(), 'voiceAgent', 'CLIENT', 1, NOW(3), NOW(3)),
  (UUID(), 'voiceAgent', 'PM', 1, NOW(3), NOW(3)),
  (UUID(), 'voiceAgent', 'OWNER', 1, NOW(3), NOW(3))
ON DUPLICATE KEY UPDATE `updatedAt` = NOW(3);
