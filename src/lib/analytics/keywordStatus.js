/**
 * KeywordTrack statuses that count as approved for rank tracking and reporting (shared string set, AGENTS.md rule 4):
 * client-approved APPROVED, legacy ACCEPTED and imported TRACKING. PROPOSED / REJECTED / EDIT_SUGGESTED are never
 * checked (each check costs money) and never counted.
 */
export const TRACKED_KEYWORD_STATUSES = Object.freeze(['APPROVED', 'ACCEPTED', 'TRACKING']);
