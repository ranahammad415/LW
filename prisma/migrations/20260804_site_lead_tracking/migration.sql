-- First-party Bridge lead / intent event tracking

CREATE TABLE IF NOT EXISTS `siteleadevent` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `eventType` VARCHAR(40) NOT NULL,
  `ruleId` VARCHAR(80) NULL,
  `ruleLabel` VARCHAR(255) NULL,
  `pageUrl` VARCHAR(1000) NULL,
  `pagePath` VARCHAR(500) NULL,
  `visitorId` VARCHAR(80) NULL,
  `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `meta` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `siteleadevent_projectId_occurredAt_idx` (`projectId`, `occurredAt`),
  INDEX `siteleadevent_projectId_eventType_occurredAt_idx` (`projectId`, `eventType`, `occurredAt`),
  CONSTRAINT `siteleadevent_projectId_fkey`
    FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `siteleaddailymetric` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `date` DATE NOT NULL,
  `phoneClicks` INT NOT NULL DEFAULT 0,
  `emailClicks` INT NOT NULL DEFAULT 0,
  `formSubmits` INT NOT NULL DEFAULT 0,
  `thankYouViews` INT NOT NULL DEFAULT 0,
  `leads` INT NOT NULL DEFAULT 0,
  `breakdowns` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `siteleaddailymetric_projectId_date_key` (`projectId`, `date`),
  INDEX `siteleaddailymetric_projectId_date_idx` (`projectId`, `date`),
  CONSTRAINT `siteleaddailymetric_projectId_fkey`
    FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
