-- Persist WordPress pipeline timestamps so "Updated" shows when the review
-- was initiated/changed in WP, not when Agency OS last synced the row.
ALTER TABLE `wpcontentreview`
  ADD COLUMN `wpCreatedAt` DATETIME(3) NULL,
  ADD COLUMN `wpUpdatedAt` DATETIME(3) NULL;

-- Backfill from synced history events (WP times were stored on event.createdAt).
UPDATE `wpcontentreview` r
SET
  r.`wpCreatedAt` = (
    SELECT MIN(e.`createdAt`) FROM `wpcontentreviewevent` e WHERE e.`contentReviewId` = r.`id`
  ),
  r.`wpUpdatedAt` = (
    SELECT MAX(e.`createdAt`) FROM `wpcontentreviewevent` e WHERE e.`contentReviewId` = r.`id`
  );
