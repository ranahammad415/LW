/**
 * Security carry-forward (plan f.5): security-negative changes made since the backup survive the restore.
 * Snapshot BEFORE the drop: user (id, tokenVersion, passwordHash, isActive, 2FA), revoked apitoken rows, revoked
 * mcpgrant ids (when that table exists). AFTER the load, in one transaction:
 *   - every user present now: tokenVersion = GREATEST(restored, current) + 1 (all JWTs / refresh cookies / grants die);
 *     with carryForwardCredentials (default on) passwordHash and the 2FA fields take the CURRENT values;
 *     isActive = restored AND current (a deactivation is kept);
 *   - users only in the restored data: tokenVersion + 1;
 *   - API-token revocations re-applied; live tokens get userTokenVersion = the new tokenVersion (agents keep working);
 *   - mcpgrant / mcptoken (MCP branch tables, if present) all revoked, so connectors reconnect.
 * Nothing here is logged (it is credential data). The plan is pure so it can be unit-tested.
 */

export async function tableExists(db, table) {
  const rows = await db.rows('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
  return Number(rows?.[0]?.n) > 0;
}
async function columnExists(db, table, col) {
  const rows = await db.rows('SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, col]);
  return Number(rows?.[0]?.n) > 0;
}

export async function takeSnapshot(db) {
  const snap = { users: [], revokedApiTokens: [], revokedMcpGrantIds: [], hasMcpGrant: false, hasMcpToken: false };
  if (await tableExists(db, 'user')) {
    snap.users = await db.rows('SELECT `id`, `tokenVersion`, `passwordHash`, `isActive`, `twoFaSecret`, `twoFaEnabled`, `twoFaBackupCodes` FROM `user`');
  }
  if (await tableExists(db, 'apitoken')) {
    snap.revokedApiTokens = await db.rows('SELECT `id`, `revokedAt`, `revokedById` FROM `apitoken` WHERE `revokedAt` IS NOT NULL');
  }
  snap.hasMcpGrant = (await tableExists(db, 'mcpgrant')) && (await columnExists(db, 'mcpgrant', 'revokedAt'));
  snap.hasMcpToken = (await tableExists(db, 'mcptoken')) && (await columnExists(db, 'mcptoken', 'revokedAt'));
  if (snap.hasMcpGrant) snap.revokedMcpGrantIds = (await db.rows('SELECT `id` FROM `mcpgrant` WHERE `revokedAt` IS NOT NULL')).map((r) => String(r.id));
  return snap;
}

const bool = (v) => v === true || v === 1 || v === '1' || (Buffer.isBuffer(v) && v[0] === 1);

/**
 * Pure: the statements to run after the load. `mode`:
 *   'restore'  → full carry-forward from the snapshot (credentials optional);
 *   'rollback' → the safety backup already holds the latest credentials: only bump sessions / sync tokens / revoke MCP.
 */
export function buildCarryForwardPlan(snap, { carryForwardCredentials = true, mode = 'restore', hasApiToken = true, hasMcpGrant = snap?.hasMcpGrant, hasMcpToken = snap?.hasMcpToken } = {}) {
  const stmts = [];
  const users = mode === 'restore' ? snap?.users || [] : [];
  const ids = users.map((u) => String(u.id));
  if (ids.length) {
    stmts.push({ sql: `UPDATE \`user\` SET \`tokenVersion\` = \`tokenVersion\` + 1 WHERE \`id\` NOT IN (${ids.map(() => '?').join(',')})`, params: ids });
    for (const u of users) {
      const sets = ['`tokenVersion` = GREATEST(`tokenVersion`, ?) + 1', '`isActive` = (`isActive` AND ?)'];
      const params = [Number(u.tokenVersion) || 0, bool(u.isActive) ? 1 : 0];
      if (carryForwardCredentials) {
        sets.push('`passwordHash` = ?', '`twoFaSecret` = ?', '`twoFaEnabled` = ?', '`twoFaBackupCodes` = ?');
        params.push(u.passwordHash, u.twoFaSecret ?? null, bool(u.twoFaEnabled) ? 1 : 0, u.twoFaBackupCodes === undefined ? null : u.twoFaBackupCodes);
      }
      stmts.push({ sql: `UPDATE \`user\` SET ${sets.join(', ')} WHERE \`id\` = ?`, params: [...params, String(u.id)] });
    }
  } else {
    stmts.push({ sql: 'UPDATE `user` SET `tokenVersion` = `tokenVersion` + 1', params: [] });
  }
  if (hasApiToken) {
    for (const t of mode === 'restore' ? snap?.revokedApiTokens || [] : []) {
      stmts.push({ sql: 'UPDATE `apitoken` SET `revokedAt` = ?, `revokedById` = ? WHERE `id` = ? AND `revokedAt` IS NULL', params: [t.revokedAt, t.revokedById ?? null, String(t.id)] });
    }
    stmts.push({ sql: 'UPDATE `apitoken` a JOIN `user` u ON u.`id` = a.`userId` SET a.`userTokenVersion` = u.`tokenVersion` WHERE a.`revokedAt` IS NULL', params: [] });
  }
  if (hasMcpGrant) stmts.push({ sql: 'UPDATE `mcpgrant` SET `revokedAt` = UTC_TIMESTAMP(3) WHERE `revokedAt` IS NULL', params: [] });
  if (hasMcpToken) stmts.push({ sql: 'UPDATE `mcptoken` SET `revokedAt` = UTC_TIMESTAMP(3) WHERE `revokedAt` IS NULL', params: [] });
  return stmts;
}

/** Run the plan in one transaction on the data connection. */
export async function applyCarryForward(db, snap, opts = {}) {
  const hasApiToken = await tableExists(db, 'apitoken');
  const hasUser = await tableExists(db, 'user');
  if (!hasUser) return { statements: 0 };
  const hasMcpGrant = (await tableExists(db, 'mcpgrant')) && (await columnExists(db, 'mcpgrant', 'revokedAt'));
  const hasMcpToken = (await tableExists(db, 'mcptoken')) && (await columnExists(db, 'mcptoken', 'revokedAt'));
  const plan = buildCarryForwardPlan(snap, { ...opts, hasApiToken, hasMcpGrant, hasMcpToken });
  await db.exec('START TRANSACTION');
  try {
    for (const s of plan) await db.exec(s.sql, s.params);
    await db.exec('COMMIT');
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    throw err;
  }
  return { statements: plan.length };
}
