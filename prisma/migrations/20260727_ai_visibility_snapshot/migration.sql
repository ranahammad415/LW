-- AI Visibility snapshots (OpenRouter probes + DataForSEO LLM Mentions)
CREATE TABLE IF NOT EXISTS `aivisibilityrun` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `clientId` VARCHAR(191) NOT NULL,
  `status` VARCHAR(30) NOT NULL DEFAULT 'pending',
  `triggeredById` VARCHAR(191) NULL,
  `startedAt` DATETIME(3) NULL,
  `finishedAt` DATETIME(3) NULL,
  `queryCount` INT NOT NULL DEFAULT 0,
  `modelCount` INT NOT NULL DEFAULT 0,
  `gscRangeStart` DATE NULL,
  `gscRangeEnd` DATE NULL,
  `error` VARCHAR(1000) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `aivisibilityrun_projectId_createdAt_idx`(`projectId`, `createdAt`),
  INDEX `aivisibilityrun_clientId_createdAt_idx`(`clientId`, `createdAt`),
  INDEX `aivisibilityrun_status_idx`(`status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `aivisibilityresult` (
  `id` VARCHAR(191) NOT NULL,
  `runId` VARCHAR(191) NOT NULL,
  `query` VARCHAR(500) NOT NULL,
  `platform` VARCHAR(50) NOT NULL,
  `openrouterModel` VARCHAR(120) NOT NULL,
  `cited` BOOLEAN NOT NULL DEFAULT false,
  `citationType` VARCHAR(30) NULL,
  `responseText` LONGTEXT NULL,
  `competitorsJson` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `aivisibilityresult_runId_platform_idx`(`runId`, `platform`),
  INDEX `aivisibilityresult_runId_query_idx`(`runId`, `query`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `aivisibilitydfssnapshot` (
  `id` VARCHAR(191) NOT NULL,
  `runId` VARCHAR(191) NOT NULL,
  `domain` VARCHAR(255) NULL,
  `payload` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `aivisibilitydfssnapshot_runId_key`(`runId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @db := DATABASE();

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'aivisibilityrun'
    AND CONSTRAINT_NAME = 'aivisibilityrun_projectId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `aivisibilityrun` ADD CONSTRAINT `aivisibilityrun_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'aivisibilityresult'
    AND CONSTRAINT_NAME = 'aivisibilityresult_runId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `aivisibilityresult` ADD CONSTRAINT `aivisibilityresult_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `aivisibilityrun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'aivisibilitydfssnapshot'
    AND CONSTRAINT_NAME = 'aivisibilitydfssnapshot_runId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `aivisibilitydfssnapshot` ADD CONSTRAINT `aivisibilitydfssnapshot_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `aivisibilityrun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
