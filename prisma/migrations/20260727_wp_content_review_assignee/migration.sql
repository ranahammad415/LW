-- OS-side worker assignee for content review pipelines.
ALTER TABLE `wpcontentreview`
  ADD COLUMN `assignedWorkerId` VARCHAR(100) NULL,
  ADD COLUMN `assignedWorkerName` VARCHAR(200) NULL;

CREATE INDEX `wpcontentreview_assignedWorkerId_idx` ON `wpcontentreview`(`assignedWorkerId`);

-- Backfill: default assignee = submitter when missing.
UPDATE `wpcontentreview`
SET `assignedWorkerId` = `submittedById`,
    `assignedWorkerName` = `submittedByName`
WHERE `assignedWorkerId` IS NULL
  AND `submittedById` IS NOT NULL;
