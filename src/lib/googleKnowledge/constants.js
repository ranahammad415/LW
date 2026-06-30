/**
 * Google Knowledge Extractor - shared constants.
 */

export const DEFAULT_MAX_DEPTH = Number(
  process.env.EXTRACT_MAX_DEPTH || process.env.GOOGLE_EXTRACT_MAX_DEPTH || 8,
);
export const DEFAULT_MAX_FILES = Number(
  process.env.EXTRACT_MAX_FILES || process.env.GOOGLE_EXTRACT_MAX_FILES || 200,
);
export const DEFAULT_RATE_LIMIT_MS = Number(
  process.env.EXTRACT_RATE_LIMIT_MS || process.env.GOOGLE_EXTRACT_RATE_MS || 120,
);

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
];

export const FILE_KIND = {
  DOCUMENT: 'document',
  SPREADSHEET: 'spreadsheet',
  DRIVE_FILE: 'drive_file',
  FOLDER: 'folder',
  UNKNOWN: 'unknown',
};

export const LIKELY_ROLE = {
  TASK_PLAN: 'task_plan',
  PROGRESS_UPDATE: 'progress_update',
  CONTEXT: 'context',
  UNKNOWN: 'unknown',
};

/** MIME types we treat as Google Docs / Sheets. */
export const MIME = {
  GOOGLE_DOC: 'application/vnd.google-apps.document',
  GOOGLE_SHEET: 'application/vnd.google-apps.spreadsheet',
  GOOGLE_FOLDER: 'application/vnd.google-apps.folder',
  GOOGLE_SHORTCUT: 'application/vnd.google-apps.shortcut',
};

export const EXTRACTIONS_DIR_NAME = 'extractions';

export const ROLE_KEYWORDS = {
  [LIKELY_ROLE.TASK_PLAN]: [
    'task plan',
    'action plan',
    'roadmap',
    'sprint plan',
    'project plan',
    'planning',
    'backlog',
    'milestones',
    'main task',
    'sub task',
    'assignee',
    'milestone',
  ],
  [LIKELY_ROLE.PROGRESS_UPDATE]: [
    'progress update',
    'status update',
    'weekly update',
    'standup',
    'recap',
    'done this week',
    'wins',
    'completed',
    'in progress',
    'blocked',
    'needs review',
  ],
  [LIKELY_ROLE.CONTEXT]: [
    'context',
    'background',
    'overview',
    'brief',
    'onboarding',
    'reference',
    'notes',
  ],
};