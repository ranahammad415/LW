// Lightweight in-memory pub/sub for Server-Sent Events.
//
// Subscribers are HTTP responses (Fastify reply.raw / Node ServerResponse) that
// are kept open and written to whenever an event for their project is
// published. This is good enough for a single backend process; if we ever
// horizontally scale we will need to replace the in-memory bus with Redis
// pub/sub or similar.

const channels = new Map(); // projectId -> Set<{ res, userId }>

/**
 * Register an SSE subscriber for a project.
 * Returns an unsubscribe function.
 */
export function subscribe(projectId, res, userId) {
  if (!projectId || !res) return () => {};
  let set = channels.get(projectId);
  if (!set) {
    set = new Set();
    channels.set(projectId, set);
  }
  const entry = { res, userId };
  set.add(entry);
  return () => {
    set.delete(entry);
    if (set.size === 0) channels.delete(projectId);
  };
}

/**
 * Publish an event to every subscriber of a project. Safe to call from
 * webhook handlers — failures (closed sockets) are swallowed.
 */
export function publish(projectId, event, payload) {
  if (!projectId) return;
  const set = channels.get(projectId);
  if (!set || set.size === 0) return;
  const data = JSON.stringify(payload ?? {});
  const frame = `event: ${event}\ndata: ${data}\n\n`;
  for (const { res } of set) {
    try {
      res.write(frame);
    } catch {
      // ignore — onClose handler will remove the subscriber
    }
  }
}

/** Diagnostic helper. */
export function subscriberCount(projectId) {
  return channels.get(projectId)?.size ?? 0;
}
