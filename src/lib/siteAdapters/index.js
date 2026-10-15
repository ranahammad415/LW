/**
 * SiteAdapter seam (plan §3.4 O2): pick the CMS adapter for a project.
 * WordPress code paths stay where they were and call `wordpress.js` helpers; EmDash
 * code paths go through `emdash.js`. Both feed the same WpContentReview / WpPage
 * tables and the shared lib/reviewEvents.js.
 */
import { wordpressAdapter } from './wordpress.js';
import { emdashAdapter } from './emdash.js';

export const CMS_TYPES = Object.freeze(['WORDPRESS', 'EMDASH']);

export function isEmdashProject(project) {
  return project?.cmsType === 'EMDASH';
}

/** @returns {import('./types.js').SiteAdapter} */
export function getAdapter(project) {
  return isEmdashProject(project) ? emdashAdapter : wordpressAdapter;
}

/** Human label for the project's CMS ("WordPress" | "EmDash"). */
export function cmsLabel(project) {
  return isEmdashProject(project) ? 'EmDash' : 'WordPress';
}

export { wordpressAdapter, emdashAdapter };
