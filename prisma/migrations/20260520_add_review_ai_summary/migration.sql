-- AlterTable: add aiSummary column to wpcontentreview
-- Idempotent: safe to run multiple times (skips if already exists on MySQL 8+).
ALTER TABLE `wpcontentreview` ADD COLUMN `aiSummary` TEXT NULL;
