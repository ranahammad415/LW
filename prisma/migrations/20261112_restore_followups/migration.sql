-- EmDash contract 1.9.1 follow-ups (site team answers, 2026-10-23; docs/ledger/emdash-bridge.md §v1.9.1):
-- GHL lead mirrors removed by a site database restore / rollback are re-queued on lead-import with a new idempotency
-- epoch, once per restore and once per rollback.
-- A separate migration on purpose: databases that already applied 20261111_backup_restore (the site team's dev DB)
-- never re-run it (Prisma keeps its checksum), so these columns must come in a new one. Additive and idempotent
-- (information_schema + PREPARE): safe to run again by hand, and on a database where they already exist.
-- The DDL matches `prisma migrate diff` (schema at 20261111 → branch schema).

SET @db := DATABASE();

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmslead' AND COLUMN_NAME = 'mirrorRestoreId');
SET @sql := IF(@col = 0, 'ALTER TABLE `cmslead` ADD COLUMN `mirrorRestoreId` VARCHAR(64) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'siterestore' AND COLUMN_NAME = 'remirrorAt');
SET @sql := IF(@col = 0, 'ALTER TABLE `siterestore` ADD COLUMN `remirrorAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'siterestore' AND COLUMN_NAME = 'remirrorRollbackAt');
SET @sql := IF(@col = 0, 'ALTER TABLE `siterestore` ADD COLUMN `remirrorRollbackAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
