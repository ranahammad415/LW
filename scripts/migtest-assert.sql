-- Asserts the content-map WordPress sync migration produced what it promised.
USE migtest;

SELECT 'new_columns_present' AS check_name,
       COUNT(*) AS actual, 13 AS expected
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'migtest' AND TABLE_NAME = 'contentmapnode'
  AND COLUMN_NAME IN ('source','lifecycle','wpPageId','wpContentReviewId','url','pathDepth',
                      'plannedPublishDate','publishedAt','workCycleId','assigneeId',
                      'keywords','metrics','metricsAt');

SELECT 'legacy_columns_intact' AS check_name,
       COUNT(*) AS actual, 27 AS expected
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'migtest' AND TABLE_NAME = 'contentmapnode'
  AND COLUMN_NAME NOT IN ('source','lifecycle','wpPageId','wpContentReviewId','url','pathDepth',
                          'plannedPublishDate','publishedAt','workCycleId','assigneeId',
                          'keywords','metrics','metricsAt');

SELECT 'new_indexes' AS check_name,
       COUNT(DISTINCT INDEX_NAME) AS actual, 3 AS expected
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = 'migtest' AND TABLE_NAME = 'contentmapnode'
  AND INDEX_NAME IN ('contentmapnode_mapId_lifecycle_idx',
                     'contentmapnode_mapId_plannedPublishDate_idx',
                     'contentmapnode_wpPageId_idx');

SELECT 'new_foreign_keys' AS check_name,
       COUNT(*) AS actual, 9 AS expected
FROM information_schema.TABLE_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = 'migtest' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  AND TABLE_NAME IN ('contentmapnode','contentmapsync','contentmapdrift');

SELECT 'new_tables' AS check_name,
       COUNT(*) AS actual, 2 AS expected
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'migtest' AND TABLE_NAME IN ('contentmapsync','contentmapdrift');

SELECT 'isLive_backfilled_to_LIVE' AS check_name,
       (SELECT lifecycle FROM contentmapnode WHERE id = 'migtest-live') AS actual,
       'LIVE' AS expected;

SELECT 'non_live_defaults_to_PLANNED' AS check_name,
       (SELECT lifecycle FROM contentmapnode WHERE id = 'migtest-draft') AS actual,
       'PLANNED' AS expected;

SELECT 'source_defaults_to_PLANNED' AS check_name,
       (SELECT source FROM contentmapnode WHERE id = 'migtest-live') AS actual,
       'PLANNED' AS expected;

SELECT 'notification_templates' AS check_name,
       COUNT(*) AS actual, 3 AS expected
FROM notificationtemplate
WHERE slug IN ('content_map_node_published','content_map_site_drift','content_map_node_overdue');
