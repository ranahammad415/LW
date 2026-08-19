-- "Update Content" workflow + content-type change logging.
-- parentWpPostId: for update-mode reviews, the live parent page the draft was
-- cloned from (lets the OS keep logs on the parent after the draft is deleted).
ALTER TABLE `wpcontentreview`
  ADD COLUMN `parentWpPostId` INT NULL;

-- Generic human-readable log line on a timeline event (e.g. content-type change).
ALTER TABLE `wpcontentreviewevent`
  ADD COLUMN `message` VARCHAR(500) NULL;
