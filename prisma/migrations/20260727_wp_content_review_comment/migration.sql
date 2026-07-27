-- Freeform OS comments on content reviews (idempotent).
-- Table/FKs may already exist from a prior db push.

CREATE TABLE IF NOT EXISTS `wpcontentreviewcomment` (
  `id` VARCHAR(191) NOT NULL,
  `contentReviewId` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `content` LONGTEXT NOT NULL,
  `parentId` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `wpcontentreviewcomment_contentReviewId_createdAt_idx`(`contentReviewId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @db := DATABASE();

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db
    AND TABLE_NAME = 'wpcontentreviewcomment'
    AND CONSTRAINT_NAME = 'wpcontentreviewcomment_contentReviewId_fkey'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `wpcontentreviewcomment` ADD CONSTRAINT `wpcontentreviewcomment_contentReviewId_fkey` FOREIGN KEY (`contentReviewId`) REFERENCES `wpcontentreview`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db
    AND TABLE_NAME = 'wpcontentreviewcomment'
    AND CONSTRAINT_NAME = 'wpcontentreviewcomment_userId_fkey'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `wpcontentreviewcomment` ADD CONSTRAINT `wpcontentreviewcomment_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db
    AND TABLE_NAME = 'wpcontentreviewcomment'
    AND CONSTRAINT_NAME = 'wpcontentreviewcomment_parentId_fkey'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `wpcontentreviewcomment` ADD CONSTRAINT `wpcontentreviewcomment_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `wpcontentreviewcomment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
