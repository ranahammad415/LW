-- Seeding a knowledge base from a client's live website. One row per crawl
-- attempt; the extracted sections go to okfdraftchange for human approval.

CREATE TABLE IF NOT EXISTS `knowledgecrawlrun` (
  `id` VARCHAR(191) NOT NULL,
  `clientId` VARCHAR(255) NOT NULL,
  `projectId` VARCHAR(255) NULL,
  `rootUrl` VARCHAR(1000) NOT NULL,
  `status` VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  `triggeredById` VARCHAR(255) NULL,
  `startedAt` DATETIME(3) NULL,
  `finishedAt` DATETIME(3) NULL,
  `pagesCrawled` INT NOT NULL DEFAULT 0,
  `draftsCreated` INT NOT NULL DEFAULT 0,
  `error` VARCHAR(1000) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `knowledgecrawlrun_clientId_createdAt_idx` (`clientId`, `createdAt`),
  INDEX `knowledgecrawlrun_status_idx` (`status`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
