-- CreateTable: project HTML reports (per project + month)
CREATE TABLE IF NOT EXISTS `projecthtmlreport` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `month` VARCHAR(7) NOT NULL,
    `title` VARCHAR(255) NULL,
    `fileName` VARCHAR(255) NOT NULL,
    `storedPath` VARCHAR(500) NOT NULL,
    `fileSize` INTEGER NULL,
    `status` ENUM('DRAFT', 'PM_REVIEW', 'DELIVERED') NOT NULL DEFAULT 'DELIVERED',
    `uploadedById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `projecthtmlreport_projectId_month_key`(`projectId`, `month`),
    INDEX `projecthtmlreport_month_idx`(`month`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
