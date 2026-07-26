-- OS-editable description on content reviews (task-style).
ALTER TABLE `wpcontentreview`
  ADD COLUMN `description` LONGTEXT NULL;
