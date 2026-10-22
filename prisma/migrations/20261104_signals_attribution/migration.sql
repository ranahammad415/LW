-- First-party visit signals and lead attribution (EmDash contract v1.7.0 §38, plan §5).
-- Additive and idempotent: CREATE TABLE IF NOT EXISTS only. Nothing dropped, renamed or retyped; no existing table altered.
-- SignalEvent and the other signal tables carry no foreign key to project (high-volume inserts; the nightly
-- signals.retention job sweeps rows of deleted projects). leadattribution cascades with its cmslead row.
-- Checked against `prisma migrate diff` (main af3f156 schema -> this schema): same tables, columns, indexes and FK.

CREATE TABLE IF NOT EXISTS `signalevent` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `projectId` VARCHAR(191) NOT NULL,
    `eventId` CHAR(26) NOT NULL,
    `type` VARCHAR(16) NOT NULL,
    `at` DATETIME(3) NOT NULL,
    `sessionId` VARCHAR(28) NOT NULL,
    `visitorId` VARCHAR(28) NULL,
    `refClass` VARCHAR(10) NOT NULL,
    `refSource` VARCHAR(64) NULL,
    `country` VARCHAR(2) NULL,
    `pagePath` VARCHAR(2048) NOT NULL,
    `leadId` VARCHAR(64) NULL,
    `botScore` SMALLINT NOT NULL DEFAULT 0,
    `sessionizedAt` DATETIME(3) NULL,
    `payloadCompactedAt` DATETIME(3) NULL,
    `payload` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `signalevent_projectId_at_idx`(`projectId`, `at`),
    INDEX `signalevent_projectId_sessionId_idx`(`projectId`, `sessionId`),
    INDEX `signalevent_projectId_visitorId_at_idx`(`projectId`, `visitorId`, `at`),
    INDEX `signalevent_projectId_type_at_idx`(`projectId`, `type`, `at`),
    INDEX `signalevent_projectId_leadId_idx`(`projectId`, `leadId`),
    INDEX `signalevent_projectId_sessionizedAt_idx`(`projectId`, `sessionizedAt`),
    INDEX `signalevent_sessionizedAt_at_idx`(`sessionizedAt`, `at`),
    INDEX `signalevent_payloadCompactedAt_at_idx`(`payloadCompactedAt`, `at`),
    UNIQUE INDEX `signalevent_projectId_eventId_key`(`projectId`, `eventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `signalsession` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(28) NOT NULL,
    `visitorId` VARCHAR(28) NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `endedAt` DATETIME(3) NOT NULL,
    `landingPath` VARCHAR(2048) NOT NULL,
    `exitPath` VARCHAR(2048) NULL,
    `pageviews` INTEGER NOT NULL DEFAULT 0,
    `engagedSec` INTEGER NOT NULL DEFAULT 0,
    `engaged` BOOLEAN NOT NULL DEFAULT false,
    `ctaClicks` INTEGER NOT NULL DEFAULT 0,
    `formStarts` INTEGER NOT NULL DEFAULT 0,
    `refClass` VARCHAR(10) NOT NULL,
    `refSource` VARCHAR(64) NULL,
    `utmCampaign` VARCHAR(200) NULL,
    `formFactor` VARCHAR(10) NULL,
    `uaFamily` VARCHAR(20) NULL,
    `country` VARCHAR(2) NULL,
    `region` VARCHAR(8) NULL,
    `city` VARCHAR(80) NULL,
    `tz` VARCHAR(64) NULL,
    `localHour` SMALLINT NULL,
    `ipPrefix` VARCHAR(20) NULL,
    `captureBotScore` SMALLINT NOT NULL DEFAULT 0,
    `rescoreBotScore` SMALLINT NULL,
    `botScore` SMALLINT NOT NULL DEFAULT 0,
    `botReasons` JSON NULL,
    `isNewVisitor` BOOLEAN NOT NULL DEFAULT false,
    `sessionOnly` BOOLEAN NOT NULL DEFAULT false,
    `leadId` VARCHAR(64) NULL,
    `touch` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `signalsession_projectId_startedAt_idx`(`projectId`, `startedAt`),
    INDEX `signalsession_projectId_visitorId_startedAt_idx`(`projectId`, `visitorId`, `startedAt`),
    INDEX `signalsession_projectId_refClass_startedAt_idx`(`projectId`, `refClass`, `startedAt`),
    INDEX `signalsession_projectId_leadId_idx`(`projectId`, `leadId`),
    UNIQUE INDEX `signalsession_projectId_sessionId_key`(`projectId`, `sessionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `leadattribution` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `leadRowId` VARCHAR(191) NOT NULL,
    `siteLeadId` VARCHAR(64) NOT NULL,
    `leadAt` DATETIME(3) NOT NULL,
    `visitorId` VARCHAR(28) NULL,
    `sessionId` VARCHAR(28) NULL,
    `model` VARCHAR(16) NOT NULL,
    `siteSnapshot` JSON NULL,
    `sitePath` JSON NULL,
    `firstTouch` JSON NULL,
    `lastTouch` JSON NULL,
    `lastClass` VARCHAR(10) NOT NULL DEFAULT 'unknown',
    `lastSource` VARCHAR(64) NOT NULL DEFAULT '',
    `landingPath` VARCHAR(2048) NULL,
    `formId` VARCHAR(40) NULL,
    `placement` VARCHAR(40) NULL,
    `heardFrom` VARCHAR(100) NULL,
    `country` VARCHAR(2) NULL,
    `region` VARCHAR(8) NULL,
    `formFactor` VARCHAR(10) NULL,
    `pathSummary` JSON NULL,
    `sessionsBeforeLead` INTEGER NULL,
    `pageviewsBeforeLead` INTEGER NULL,
    `timeToLeadSec` INTEGER NULL,
    `sessionToLeadSec` INTEGER NULL,
    `mismatch` BOOLEAN NOT NULL DEFAULT false,
    `needsDerive` BOOLEAN NOT NULL DEFAULT true,
    `derivedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `leadattribution_leadRowId_key`(`leadRowId`),
    INDEX `leadattribution_projectId_createdAt_idx`(`projectId`, `createdAt`),
    INDEX `leadattribution_projectId_visitorId_idx`(`projectId`, `visitorId`),
    INDEX `leadattribution_projectId_leadAt_idx`(`projectId`, `leadAt`),
    INDEX `leadattribution_needsDerive_idx`(`needsDerive`),
    UNIQUE INDEX `leadattribution_projectId_siteLeadId_key`(`projectId`, `siteLeadId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `leadattribution_leadRowId_fkey` FOREIGN KEY (`leadRowId`) REFERENCES `cmslead`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `signalerasure` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `subjectHash` CHAR(64) NOT NULL,
    `reason` VARCHAR(32) NULL,
    `origin` VARCHAR(8) NOT NULL DEFAULT 'os',
    `rowsEvents` INTEGER NOT NULL DEFAULT 0,
    `rowsSessions` INTEGER NOT NULL DEFAULT 0,
    `rowsAttributions` INTEGER NOT NULL DEFAULT 0,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `actor` JSON NULL,
    `siteState` VARCHAR(16) NOT NULL DEFAULT 'none',
    `siteAttempts` INTEGER NOT NULL DEFAULT 0,
    `siteNextAt` DATETIME(3) NULL,
    `siteLastError` VARCHAR(40) NULL,
    `siteRows` INTEGER NULL,
    `pendingSubject` VARCHAR(28) NULL,

    INDEX `signalerasure_projectId_at_idx`(`projectId`, `at`),
    INDEX `signalerasure_siteState_siteNextAt_idx`(`siteState`, `siteNextAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `signalingeststat` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `batches` INTEGER NOT NULL DEFAULT 0,
    `events` INTEGER NOT NULL DEFAULT 0,
    `innerDuplicates` INTEGER NOT NULL DEFAULT 0,
    `rejectedInvalid` INTEGER NOT NULL DEFAULT 0,
    `clamped` INTEGER NOT NULL DEFAULT 0,
    `botEvents` INTEGER NOT NULL DEFAULT 0,
    `siteSummary` JSON NULL,
    `siteSummaryAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `signalingeststat_projectId_date_key`(`projectId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `signaldailybysource` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `refClass` VARCHAR(10) NOT NULL,
    `refSource` VARCHAR(64) NOT NULL DEFAULT '',
    `sessions` INTEGER NOT NULL DEFAULT 0,
    `visitors` INTEGER NOT NULL DEFAULT 0,
    `newVisitors` INTEGER NOT NULL DEFAULT 0,
    `pageviews` INTEGER NOT NULL DEFAULT 0,
    `engagedSessions` INTEGER NOT NULL DEFAULT 0,
    `ctaClicks` INTEGER NOT NULL DEFAULT 0,
    `formStarts` INTEGER NOT NULL DEFAULT 0,
    `leads` INTEGER NOT NULL DEFAULT 0,
    `botSessions` INTEGER NOT NULL DEFAULT 0,

    INDEX `signaldailybysource_projectId_date_idx`(`projectId`, `date`),
    UNIQUE INDEX `signaldailybysource_projectId_date_refClass_refSource_key`(`projectId`, `date`, `refClass`, `refSource`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `signaldailybylanding` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `landingPath` VARCHAR(512) NOT NULL,
    `refClass` VARCHAR(10) NOT NULL,
    `sessions` INTEGER NOT NULL DEFAULT 0,
    `leads` INTEGER NOT NULL DEFAULT 0,
    `engagedSessions` INTEGER NOT NULL DEFAULT 0,

    INDEX `signaldailybylanding_projectId_date_idx`(`projectId`, `date`),
    UNIQUE INDEX `signaldailybylanding_projectId_date_landingPath_refClass_key`(`projectId`, `date`, `landingPath`, `refClass`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `signaldailybygeodevice` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `country` VARCHAR(2) NOT NULL DEFAULT '',
    `region` VARCHAR(8) NOT NULL DEFAULT '',
    `formFactor` VARCHAR(10) NOT NULL DEFAULT 'other',
    `sessions` INTEGER NOT NULL DEFAULT 0,
    `leads` INTEGER NOT NULL DEFAULT 0,

    INDEX `signaldailybygeodevice_projectId_date_idx`(`projectId`, `date`),
    UNIQUE INDEX `signaldailybygeodevice_projectId_date_country_region_formFac_key`(`projectId`, `date`, `country`, `region`, `formFactor`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `signalrollupdirty` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `signalrollupdirty_projectId_date_key`(`projectId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `signalconfigmirror` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `rev` INTEGER NULL,
    `config` JSON NULL,
    `buffer` JSON NULL,
    `stale` BOOLEAN NOT NULL DEFAULT false,
    `fetchedAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `signalconfigmirror_projectId_key`(`projectId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
