-- Site metrics (docs/ledger/features/site-metrics.md): PageSpeed Insights daily rows + monthly backlink snapshots.
-- Additive and idempotent: CREATE TABLE IF NOT EXISTS with the foreign keys inline. Nothing dropped, renamed or retyped.

CREATE TABLE IF NOT EXISTS `pagespeeddaily` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `date` DATE NOT NULL,
  `strategy` VARCHAR(8) NOT NULL,
  `url` VARCHAR(500) NOT NULL,
  `performanceScore` INTEGER NULL,
  `lcpMs` INTEGER NULL,
  `cls` DOUBLE NULL,
  `tbtMs` INTEGER NULL,
  `fcpMs` INTEGER NULL,
  `speedIndexMs` INTEGER NULL,
  `fieldLcpP75` INTEGER NULL,
  `fieldInpP75` INTEGER NULL,
  `fieldClsP75` DOUBLE NULL,
  `fieldCategory` VARCHAR(8) NULL,
  `status` VARCHAR(8) NOT NULL,
  `errorCode` VARCHAR(40) NULL,
  `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `pagespeeddaily_projectId_date_idx`(`projectId`, `date`),
  UNIQUE INDEX `pagespeeddaily_projectId_date_strategy_key`(`projectId`, `date`, `strategy`),
  PRIMARY KEY (`id`),
  CONSTRAINT `pagespeeddaily_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `backlinksnapshotmonthly` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `month` VARCHAR(7) NOT NULL,
  `target` VARCHAR(255) NOT NULL,
  `rank` INTEGER NULL,
  `backlinks` INTEGER NULL,
  `referringDomains` INTEGER NULL,
  `referringMainDomains` INTEGER NULL,
  `newReferringDomains` INTEGER NULL,
  `lostReferringDomains` INTEGER NULL,
  `backlinksSpamScore` INTEGER NULL,
  `brokenBacklinks` INTEGER NULL,
  `costUsd` DECIMAL(10, 5) NULL,
  `status` VARCHAR(8) NOT NULL,
  `errorCode` VARCHAR(40) NULL,
  `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `backlinksnapshotmonthly_projectId_month_key`(`projectId`, `month`),
  PRIMARY KEY (`id`),
  CONSTRAINT `backlinksnapshotmonthly_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
