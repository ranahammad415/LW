-- Test seed data for localwaves_test database
-- Fixed UUIDs for consistent test references

-- Users
INSERT INTO `User` (`id`, `email`, `passwordHash`, `role`, `name`, `avatarUrl`, `phone`, `timezone`, `twoFaEnabled`, `isActive`, `createdAt`, `updatedAt`)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'owner@test.com', '$2b$10$i1BYwmxM401VdOEv8UdssOYHXISRzV6fW4Z1OaRYm3/Srt7Qumm3O', 'OWNER', 'Test Owner', NULL, NULL, 'UTC', 0, 1, NOW(), NOW()),
  ('22222222-2222-2222-2222-222222222222', 'pm@test.com', '$2b$10$i1BYwmxM401VdOEv8UdssOYHXISRzV6fW4Z1OaRYm3/Srt7Qumm3O', 'PM', 'Test PM', NULL, NULL, 'UTC', 0, 1, NOW(), NOW()),
  ('33333333-3333-3333-3333-333333333333', 'team@test.com', '$2b$10$i1BYwmxM401VdOEv8UdssOYHXISRzV6fW4Z1OaRYm3/Srt7Qumm3O', 'TEAM_MEMBER', 'Test Team Member', NULL, NULL, 'UTC', 0, 1, NOW(), NOW()),
  ('44444444-4444-4444-4444-444444444444', 'contractor@test.com', '$2b$10$i1BYwmxM401VdOEv8UdssOYHXISRzV6fW4Z1OaRYm3/Srt7Qumm3O', 'CONTRACTOR', 'Test Contractor', NULL, NULL, 'UTC', 0, 1, NOW(), NOW()),
  ('55555555-5555-5555-5555-555555555555', 'client@test.com', '$2b$10$i1BYwmxM401VdOEv8UdssOYHXISRzV6fW4Z1OaRYm3/Srt7Qumm3O', 'CLIENT', 'Test Client', NULL, '+1234567890', 'America/New_York', 0, 1, NOW(), NOW());

-- Package
INSERT INTO `Package` (`id`, `name`, `maxKeywords`, `createdAt`)
VALUES
  ('66666666-6666-6666-6666-666666666666', 'GROWTH', 25, NOW());

-- Client Account
INSERT INTO `ClientAccount` (`id`, `packageId`, `agencyName`, `websiteUrl`, `industry`, `country`, `timezone`, `leadPmId`, `secondaryPmId`, `onboardingStatus`, `onboardingStep`, `healthScore`, `isActive`, `createdAt`, `updatedAt`)
VALUES
  ('77777777-7777-7777-7777-777777777777', '66666666-6666-6666-6666-666666666666', 'Test Agency', 'https://testagency.com', 'Technology', 'US', 'America/New_York', '22222222-2222-2222-2222-222222222222', NULL, 'PENDING', 1, 80, 1, NOW(), NOW());

-- Client User (links CLIENT user to client account)
INSERT INTO `ClientUser` (`id`, `clientId`, `userId`, `jobTitle`, `isPrimaryContact`, `canApproveDeliverables`, `canSignContracts`, `addedById`, `addedAt`)
VALUES
  ('cu-11111111-1111-1111-1111-111111111111', '77777777-7777-7777-7777-777777777777', '55555555-5555-5555-5555-555555555555', 'CEO', 1, 1, 1, '11111111-1111-1111-1111-111111111111', NOW());

-- Project
INSERT INTO `Project` (`id`, `clientId`, `name`, `projectType`, `status`, `onboardingStep`, `leadPmId`, `createdAt`, `updatedAt`)
VALUES
  ('88888888-8888-8888-8888-888888888888', '77777777-7777-7777-7777-777777777777', 'Test SEO Campaign', 'SEO_CAMPAIGN', 'ACTIVE', 1, '22222222-2222-2222-2222-222222222222', NOW(), NOW());

-- Tasks
INSERT INTO `Task` (`id`, `projectId`, `title`, `description`, `taskType`, `priority`, `dueDate`, `createdById`, `status`, `clientVisible`, `createdAt`, `updatedAt`)
VALUES
  ('99999999-9999-9999-9999-999999999991', '88888888-8888-8888-8888-888888888888', 'Initial keyword research', 'Perform initial keyword research for the client', 'KEYWORD_RESEARCH', 'HIGH', '2026-04-20 00:00:00', '22222222-2222-2222-2222-222222222222', 'TO_DO', 1, NOW(), NOW()),
  ('99999999-9999-9999-9999-999999999992', '88888888-8888-8888-8888-888888888888', 'On-page SEO audit', 'Audit all pages for on-page SEO factors', 'SEO_AUDIT', 'MEDIUM', '2026-04-25 00:00:00', '22222222-2222-2222-2222-222222222222', 'IN_PROGRESS', 1, NOW(), NOW()),
  ('99999999-9999-9999-9999-999999999993', '88888888-8888-8888-8888-888888888888', 'Setup Google Analytics', 'Configure GA4 and connect to the client site', 'ANALYTICS', 'LOW', NULL, '22222222-2222-2222-2222-222222222222', 'COMPLETED', 1, NOW(), NOW());

-- Task Assignees (many-to-many via implicit join table _TaskAssignees)
INSERT INTO `_TaskAssignees` (`A`, `B`)
VALUES
  ('99999999-9999-9999-9999-999999999991', '33333333-3333-3333-3333-333333333333'),
  ('99999999-9999-9999-9999-999999999992', '33333333-3333-3333-3333-333333333333'),
  ('99999999-9999-9999-9999-999999999993', '22222222-2222-2222-2222-222222222222');

-- Task Dependencies (many-to-many via implicit join table _TaskDependencies)
INSERT INTO `_TaskDependencies` (`A`, `B`)
VALUES
  ('99999999-9999-9999-9999-999999999991', '99999999-9999-9999-9999-999999999992');

-- Keyword Tracks
INSERT INTO `KeywordTrack` (`id`, `projectId`, `keyword`, `volume`, `currentRank`, `targetUrl`, `status`, `updatedAt`)
VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '88888888-8888-8888-8888-888888888888', 'local seo services', 1200, 15, 'https://testagency.com/local-seo', 'APPROVED', NOW()),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '88888888-8888-8888-8888-888888888888', 'seo audit tool', 800, 32, 'https://testagency.com/seo-audit', 'PROPOSED', NOW());
