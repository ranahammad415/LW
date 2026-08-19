-- Add worker-selected content/page type to content reviews so reviewers can
-- differentiate landing pages, pillar pages, articles, etc.
ALTER TABLE `wpcontentreview`
  ADD COLUMN `contentType` VARCHAR(50) NULL;
