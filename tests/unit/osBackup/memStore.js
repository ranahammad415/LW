/**
 * In-memory stand-in for src/lib/osBackup/store.js with the SAME contract (CAS functions return affected rows),
 * used via vi.mock by the OTP, lock-free route and scheduler tests. The SQL itself is covered by sqlContract tests and
 * the MySQL round trip.
 */
import crypto from 'crypto';

export function makeMemStore() {
  const t = { state: { id: 1, schedulePaused: false, consecutiveFailures: 0, lockJobId: null, heartbeatAt: null }, jobs: new Map(), backups: new Map(), challenges: new Map(), owners: [] };
  const m = {
    __t: t,
    newId: () => crypto.randomUUID(),
    prismaSql: () => ({ q: async () => [], x: async () => 0 }),
    mysqlSql: () => ({ q: async () => [], x: async () => 0 }),
    fromDb: (r) => r,
    async getState() {
      return { ...t.state };
    },
    async updateState(_db, f) {
      Object.assign(t.state, f);
      return 1;
    },
    async acquireLockRow(_db, jobId) {
      const s = t.state;
      const stale = !s.heartbeatAt || Date.now() - new Date(s.heartbeatAt).getTime() > 10 * 60_000;
      if (s.lockJobId && s.lockJobId !== jobId && !stale) return 0;
      Object.assign(s, { lockJobId: jobId, lockedAt: new Date(), heartbeatAt: new Date() });
      return 1;
    },
    async heartbeatLockRow(_db, jobId) {
      if (t.state.lockJobId !== jobId) return 0;
      t.state.heartbeatAt = new Date();
      return 1;
    },
    async releaseLockRow(_db, jobId) {
      if (t.state.lockJobId !== jobId) return 0;
      t.state.lockJobId = null;
      return 1;
    },
    async forceReleaseLockRow() {
      t.state.lockJobId = null;
      return 1;
    },
    async insertJob(_db, job) {
      const row = { status: 'QUEUED', createdAt: new Date(), ...job };
      t.jobs.set(row.id, row);
      return row;
    },
    async updateJob(_db, id, f) {
      if (!t.jobs.has(id)) return 0;
      Object.assign(t.jobs.get(id), f);
      return 1;
    },
    async getJob(_db, id) {
      return t.jobs.get(id) ? { ...t.jobs.get(id) } : null;
    },
    async activeJobs() {
      return [...t.jobs.values()].filter((j) => ['QUEUED', 'RUNNING'].includes(j.status));
    },
    async recentJobs() {
      return [...t.jobs.values()];
    },
    async insertBackup(_db, row) {
      t.backups.set(row.id, { ...row });
      return row;
    },
    async updateBackup(_db, id, f) {
      if (!t.backups.has(id)) return 0;
      Object.assign(t.backups.get(id), f);
      return 1;
    },
    async getBackup(_db, id) {
      return t.backups.get(id) ? { ...t.backups.get(id) } : null;
    },
    async getBackupByFile(_db, f) {
      return [...t.backups.values()].find((b) => b.fileName === f) || null;
    },
    async listBackups(_db, { includePruned = false } = {}) {
      return [...t.backups.values()].filter((b) => includePruned || b.status !== 'PRUNED').sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    },
    async deleteOldBackupRows() {
      return 0;
    },
    async deleteOldJobRows() {
      return 0;
    },
    async insertChallenge(_db, row) {
      t.challenges.set(row.id, { consumedAt: null, invalidatedAt: null, downloadTicketHash: null, ticketExpiresAt: null, ...row });
      return row;
    },
    async getChallenge(_db, id) {
      return t.challenges.get(id) ? { ...t.challenges.get(id) } : null;
    },
    async countChallengesSince(_db, userId, since) {
      return [...t.challenges.values()].filter((c) => c.userId === userId && c.createdAt >= since).length;
    },
    async invalidateOpenChallenges(_db, userId, action, now) {
      let n = 0;
      for (const c of t.challenges.values()) {
        if (c.userId === userId && c.action === action && !c.consumedAt && !c.invalidatedAt) {
          c.invalidatedAt = now;
          n += 1;
        }
      }
      return n;
    },
    async bumpChallengeAttempt(_db, { id, userId, action, backupId, now, maxAttempts }) {
      const c = t.challenges.get(id);
      if (!c || c.userId !== userId || c.action !== action || c.backupId !== backupId || c.consumedAt || c.invalidatedAt || !(c.expiresAt > now) || !(c.attempts < maxAttempts)) return 0;
      c.attempts += 1;
      return 1;
    },
    async consumeChallenge(_db, id, now) {
      const c = t.challenges.get(id);
      if (!c || c.consumedAt || c.invalidatedAt) return 0;
      c.consumedAt = now;
      return 1;
    },
    async resendChallengeRow(_db, { id, userId, codeHash, now, expiresAt, maxSends, minGapMs }) {
      const c = t.challenges.get(id);
      if (!c || c.userId !== userId || c.consumedAt || c.invalidatedAt || !(c.sendCount < maxSends) || !(c.lastSentAt <= new Date(now.getTime() - minGapMs)) || !(c.attempts < 5)) return 0;
      Object.assign(c, { codeHash, sendCount: c.sendCount + 1, lastSentAt: now, expiresAt });
      return 1;
    },
    async setDownloadTicket(_db, id, h, exp) {
      const c = t.challenges.get(id);
      if (!c || c.action !== 'DOWNLOAD' || !c.consumedAt) return 0;
      Object.assign(c, { downloadTicketHash: h, ticketExpiresAt: exp });
      return 1;
    },
    async findTicket(_db, h) {
      return [...t.challenges.values()].find((c) => c.downloadTicketHash === h && c.action === 'DOWNLOAD') || null;
    },
    async consumeTicket(_db, h, now) {
      const c = [...t.challenges.values()].find((x) => x.downloadTicketHash === h && x.action === 'DOWNLOAD' && x.ticketExpiresAt > now);
      if (!c) return 0;
      c.downloadTicketHash = null;
      return 1;
    },
    async purgeOldChallenges() {
      return 0;
    },
    async activeOwners() {
      return t.owners;
    },
    async agencyBranding() {
      return null;
    },
    async appliedMigrations() {
      return [];
    },
  };
  return m;
}
