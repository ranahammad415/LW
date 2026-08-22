-- Persist Owner pipeline deletes so sync / webhooks cannot recreate them.

CREATE TABLE IF NOT EXISTS `wpcontentreviewtombstone` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `wpPipelineId` INT NOT NULL,
  `deletedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `deletedById` VARCHAR(191) NULL,
  INDEX `wpcontentreviewtombstone_projectId_idx`(`projectId`),
  UNIQUE INDEX `wpcontentreviewtombstone_projectId_wpPipelineId_key`(`projectId`, `wpPipelineId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @db := DATABASE();

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db
    AND TABLE_NAME = 'wpcontentreviewtombstone'
    AND CONSTRAINT_NAME = 'wpcontentreviewtombstone_projectId_fkey'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `wpcontentreviewtombstone` ADD CONSTRAINT `wpcontentreviewtombstone_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db
    AND TABLE_NAME = 'wpcontentreviewtombstone'
    AND CONSTRAINT_NAME = 'wpcontentreviewtombstone_deletedById_fkey'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `wpcontentreviewtombstone` ADD CONSTRAINT `wpcontentreviewtombstone_deletedById_fkey` FOREIGN KEY (`deletedById`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
