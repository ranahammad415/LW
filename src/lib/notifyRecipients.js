/**
 * Small helpers for building notification recipient arrays.
 *
 * Context: we now allow an OWNER user to be linked to a client via a
 * ClientUser row so they act as a client manager for that account. That means
 * the OWNER is BOTH a normal staff member AND a potential client-side
 * recipient. Without care, a single action taken by the OWNER while acting as
 * a client could end up notifying themselves (actor == recipient) or even
 * notifying the same userId twice (once as PM, once as ClientUser).
 *
 * All recipient-building code paths should funnel through `excludeActor` to
 * guarantee:
 *   - the actor never receives a notification for their own action
 *   - the recipient list is de-duplicated
 *   - falsy entries (null/undefined) are removed
 */

/**
 * Filter out the actor's own id from a recipient list and de-duplicate.
 *
 * @param {Array<string|null|undefined>} ids
 * @param {string|null|undefined} actorId
 * @returns {string[]}
 */
export function excludeActor(ids, actorId) {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter((id) => id && id !== actorId))];
}

/**
 * Merge any number of recipient lists, remove the actor, and de-duplicate.
 *
 * @param {string|null|undefined} actorId
 * @param  {...Array<string|null|undefined>} lists
 * @returns {string[]}
 */
export function buildRecipients(actorId, ...lists) {
  const merged = [];
  for (const list of lists) {
    if (Array.isArray(list)) merged.push(...list);
  }
  return excludeActor(merged, actorId);
}
