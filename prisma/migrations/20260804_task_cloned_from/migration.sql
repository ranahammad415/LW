-- Task clone lineage for month-to-month rollover (preserve old-month history).
ALTER TABLE `task` ADD COLUMN `clonedFromTaskId` VARCHAR(191) NULL;
CREATE INDEX `task_clonedFromTaskId_idx` ON `task`(`clonedFromTaskId`);
ALTER TABLE `task` ADD CONSTRAINT `task_clonedFromTaskId_fkey`
    FOREIGN KEY (`clonedFromTaskId`) REFERENCES `task`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
