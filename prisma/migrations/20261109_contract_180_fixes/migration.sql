-- Contract-180 e2e fixes (O-C180-2): the prompt source of a scheduled AI-visibility cell (handoff | answer_target), so
-- the client "AI answers" sentence takes its service / town from handoff prompts only
-- (docs/ledger/features/analytics.md §AI visibility).
-- Additive and idempotent: information_schema check + PREPARE. Nothing dropped, renamed or retyped.

SET @db := DATABASE();

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'aivisibilityresult' AND COLUMN_NAME = 'promptSource');
SET @sql := IF(@col = 0, 'ALTER TABLE `aivisibilityresult` ADD COLUMN `promptSource` VARCHAR(16) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
