-- Agency-wide monthly work sessions + native analytics data layer.

-- CreateTable: work cycle (agency-wide monthly session)
CREATE TABLE IF NOT EXISTS `workcycle` (
    `id` VARCHAR(191) NOT NULL,
    `month` INTEGER NOT NULL,
    `year` INTEGER NOT NULL,
    `status` ENUM('OPEN', 'CLOSED') NOT NULL DEFAULT 'OPEN',
    `label` VARCHAR(100) NULL,
    `openedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `closedAt` DATETIME(3) NULL,
    `openedById` VARCHAR(191) NULL,

    UNIQUE INDEX `workcycle_month_year_key`(`month`, `year`),
    INDEX `workcycle_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: frozen per-session analytics snapshot (one per client per cycle)
CREATE TABLE IF NOT EXISTS `workcycleanalyticssnapshot` (
    `id` VARCHAR(191) NOT NULL,
    `workCycleId` VARCHAR(191) NOT NULL,
    `clientId` VARCHAR(191) NOT NULL,
    `data` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `workcycleanalyticssnapshot_workCycleId_clientId_key`(`workCycleId`, `clientId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: daily GSC time-series for native traffic/ranking charts
CREATE TABLE IF NOT EXISTS `gscdailymetric` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `clicks` INTEGER NOT NULL DEFAULT 0,
    `impressions` INTEGER NOT NULL DEFAULT 0,
    `ctr` DOUBLE NOT NULL DEFAULT 0,
    `position` DOUBLE NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `gscdailymetric_projectId_date_key`(`projectId`, `date`),
    INDEX `gscdailymetric_projectId_date_idx`(`projectId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable: associate tasks with a work cycle
ALTER TABLE `task` ADD COLUMN `workCycleId` VARCHAR(191) NULL;
CREATE INDEX `task_workCycleId_idx` ON `task`(`workCycleId`);

-- AlterTable: associate monthly reports with a work cycle
ALTER TABLE `monthlyreport` ADD COLUMN `workCycleId` VARCHAR(191) NULL;
CREATE INDEX `monthlyreport_workCycleId_idx` ON `monthlyreport`(`workCycleId`);

-- AddForeignKeys
ALTER TABLE `workcycle` ADD CONSTRAINT `workcycle_openedById_fkey`
    FOREIGN KEY (`openedById`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `workcycleanalyticssnapshot` ADD CONSTRAINT `workcycleanalyticssnapshot_workCycleId_fkey`
    FOREIGN KEY (`workCycleId`) REFERENCES `workcycle`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `workcycleanalyticssnapshot` ADD CONSTRAINT `workcycleanalyticssnapshot_clientId_fkey`
    FOREIGN KEY (`clientId`) REFERENCES `clientaccount`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `gscdailymetric` ADD CONSTRAINT `gscdailymetric_projectId_fkey`
    FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `task` ADD CONSTRAINT `task_workCycleId_fkey`
    FOREIGN KEY (`workCycleId`) REFERENCES `workcycle`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `monthlyreport` ADD CONSTRAINT `monthlyreport_workCycleId_fkey`
    FOREIGN KEY (`workCycleId`) REFERENCES `workcycle`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
