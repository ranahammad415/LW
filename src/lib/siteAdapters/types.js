/**
 * SiteAdapter seam (plan §3.4 O2). JSDoc only; no runtime code.
 *
 * @typedef {'WORDPRESS'|'EMDASH'} CmsType
 *
 * @typedef {object} AdapterCapabilities
 * @property {boolean} [pushDrafts]
 * @property {boolean} [createEntries]
 * @property {boolean} [mediaImport]
 * @property {boolean} [seoPanel]
 * @property {boolean} [seoProfiles]
 * @property {boolean} publishFromOs     Phase 1: true for WordPress, always false for EmDash
 * @property {boolean} [scheduleFromOs]
 * @property {boolean} [previewLinks]
 * @property {boolean} [rotateLinks]
 * @property {boolean} [clientReviewFromOs]
 * @property {boolean} [updateContentClone] WordPress "Update Content" clone
 * @property {boolean} [nativeDraftRevisions]
 * @property {boolean} [autoLogin]       WordPress JWT task login (EmDash: Phase 2, O9)
 * @property {boolean} [leads]
 * @property {boolean} [timeline]
 *
 * @typedef {object} AdapterInfo
 * @property {CmsType} type
 * @property {number|null} contractVersion
 * @property {AdapterCapabilities} capabilities
 *
 * @typedef {object} NormalizedReviewEvent  Input of lib/reviewEvents.js applyReviewEvent
 * @property {'WORDPRESS'|'EMDASH'} source
 * @property {number} wpPipelineId          WP pipeline id, or the EmDash surrogate reviewNo
 * @property {string} eventType             pipeline_* (same strings on both CMSs)
 * @property {number} wpPostId              WP post id, or the EmDash surrogate entryNo
 * @property {string} postTitle
 * @property {string} postType
 * @property {string|null} contentType
 * @property {number|null} parentWpPostId
 * @property {string|null} logMessage
 * @property {string} status
 * @property {number} revisionNumber
 * @property {string|null} pmPreviewUrl
 * @property {string|null} clientPreviewUrl
 * @property {string|null} pmDecision
 * @property {string|null} pmComment
 * @property {string|null} clientDecision
 * @property {string|null} clientComment
 * @property {string|null} submittedByName
 * @property {string|null} submittedById
 * @property {string|null} pmMemberName
 * @property {string|null} pmMemberId
 * @property {string|null} workerNote
 * @property {string|null} pmReviewedAt
 * @property {string|null} clientReviewedAt
 * @property {Date|null} wpCreatedAt
 * @property {Date} wpUpdatedAt
 * @property {string} summaryExcerpt        text for the AI summary on submit/resubmit
 * @property {boolean} isElementor
 * @property {boolean} testMode             WP resend test mode only
 * @property {object} testEmails
 * @property {{reviewId:string|null, entryId:string|null, revisionId:string|null, seq:number|null, editUrl:string|null}|null} cms
 *
 * @typedef {object} SiteAdapter
 * @property {CmsType} type
 * @property {(project: object) => AdapterInfo} info
 * @property {(project: object) => boolean} isConfigured
 */
export {};
