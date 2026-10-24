/**
 * Job lock (plan e.2), two layers:
 *   1. the osbackupstate row: CAS on lockJobId, taken over only when the holder's heartbeat is > 10 min old;
 *   2. GET_LOCK('lwos', 0) on the worker's control connection, released by MySQL if the process dies.
 * The worker heartbeats every 15 s. Crons only try on the PM2 leader.
 */
import * as store from './store.js';

export const LOCK_NAME = 'lwos';
export const STALE_MINUTES = 10;
export const HEARTBEAT_MS = 15_000;

export async function acquireLock(db, jobId) {
  return (await store.acquireLockRow(db, jobId, STALE_MINUTES)) === 1;
}

export async function heartbeat(db, jobId) {
  return (await store.heartbeatLockRow(db, jobId)) === 1;
}

export async function releaseLock(db, jobId) {
  return (await store.releaseLockRow(db, jobId)) === 1;
}

/** MySQL named lock on `adapter` (store adapter over the control connection). */
export async function getMysqlLock(db) {
  const rows = await db.q(`SELECT GET_LOCK('${LOCK_NAME}', 0) AS l`);
  return Number(rows?.[0]?.l) === 1;
}
export async function releaseMysqlLock(db) {
  await db.q(`SELECT RELEASE_LOCK('${LOCK_NAME}') AS r`).catch(() => {});
}

/** Lock state as the scheduler / routes see it (held = a holder with a fresh heartbeat). */
export function lockHeld(state, now = new Date()) {
  if (!state?.lockJobId) return false;
  const hb = state.heartbeatAt ? new Date(state.heartbeatAt).getTime() : 0;
  return now.getTime() - hb < STALE_MINUTES * 60_000;
}

/** Leader-only wrapper: a non-leader never touches the lock. */
export async function tryLockOnLeader({ leader, db, jobId }) {
  if (!leader()) return { skipped: 'not-leader' };
  return { acquired: await acquireLock(db, jobId) };
}
