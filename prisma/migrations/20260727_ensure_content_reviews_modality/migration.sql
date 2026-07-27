-- Ensure Content Reviews modality is enabled for all portals that use it
-- (idempotent; safe to re-run on older DBs where enabled may still be 0).
INSERT INTO `modality_config` (`id`, `featureKey`, `role`, `enabled`, `createdAt`, `updatedAt`)
VALUES
  (UUID(), 'contentReviews', 'OWNER', 1, NOW(3), NOW(3)),
  (UUID(), 'contentReviews', 'PM', 1, NOW(3), NOW(3)),
  (UUID(), 'contentReviews', 'TEAM_MEMBER', 1, NOW(3), NOW(3)),
  (UUID(), 'contentReviews', 'CONTRACTOR', 1, NOW(3), NOW(3)),
  (UUID(), 'contentReviews', 'CLIENT', 1, NOW(3), NOW(3))
ON DUPLICATE KEY UPDATE `enabled` = 1, `updatedAt` = NOW(3);
