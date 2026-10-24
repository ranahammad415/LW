/**
 * OS Backups security emails (plan g.2). Sent with sendEmail directly: NOT through notify(), NOT paused by
 * NOTIFICATION_EMAILS_PAUSED (security mail always goes out, like passwordResetEmail.js). Branding is passed in
 * (`settings`, captured before maintenance), so rendering never touches the DB. No backup data in any email:
 * times, sizes, names and next steps only. The OTP code is in the body, never in the subject.
 */
import { sendEmail } from '../mailer.js';
import { wrapInBrandedLayout } from '../emailLayout.js';

const APP_URL = () => process.env.FRONTEND_URL?.split(',')[0]?.trim() || 'http://localhost:5173';

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${v} B`;
}
export function fmtTime(d) {
  if (!d) return 'unknown time';
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? 'unknown time' : `${x.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}
const hoursSince = (d, now = new Date()) => Math.max(0, Math.round((now.getTime() - new Date(d).getTime()) / 3_600_000));

const p = (html) => `<p style="margin:0 0 12px 0;">${html}</p>`;
const box = (html) => `<div style="margin:12px 0;padding:12px 16px;border-radius:8px;background:#f1f5f9;font-size:14px;">${html}</div>`;
const code = (t) => `<code style="font-family:Consolas,monospace;background:#e2e8f0;padding:2px 6px;border-radius:4px;">${esc(t)}</code>`;

const CLI_FAILED_ROLLBACK = (safetyFile) => [
  `cd ~/LW && npm run os-backup -- restore --file ~/os-backups/backups/${safetyFile || '<safety>.lwbk'} --yes`,
  'npm run os-backup -- maintenance off --yes',
];
const CLI_MIGRATE = 'cd ~/LW && npx prisma migrate deploy';

/** Pure renderers: data → { subject, preheader, html (body only), text }. */
export const templates = {
  restoreOtp: (d) => ({
    subject: 'Your OS restore code',
    preheader: 'Use this code to confirm the restore. It expires in 10 minutes.',
    html:
      p(`${esc(d.name || 'Hi')}, you asked to restore Agency OS to the backup from <strong>${esc(fmtTime(d.backupAt))}</strong> (${esc(fmtBytes(d.backupBytes))}).`) +
      `<p style="margin:16px 0;font-size:28px;font-weight:700;letter-spacing:6px;">${esc(d.code)}</p>` +
      p('The code expires in 10 minutes and works once.') +
      box(
        `During the restore Agency OS is in maintenance for everyone (about 2–5 minutes plus a safety backup). Up to <strong>${esc(hoursSince(d.backupAt, d.now))} hours</strong> of changes made since this backup will be lost; the safety backup taken first lets you undo it. Everyone signs in again afterwards. Do not restart PM2 while it runs.`
      ) +
      p("<strong>Didn't request this?</strong> Change your password now and tell the other owners."),
    text: `Your OS restore code: ${d.code}\nBackup: ${fmtTime(d.backupAt)} (${fmtBytes(d.backupBytes)})\nExpires in 10 minutes, single use.\nUp to ${hoursSince(d.backupAt, d.now)} hours of changes since the backup will be lost (undo from the safety backup). Do not restart PM2 during the restore.\nDidn't request this? Change your password and tell the other owners.`,
  }),
  restoreRequested: (d) => ({
    subject: 'An OS restore was requested',
    preheader: `${d.actorEmail} asked to restore Agency OS.`,
    html:
      p(`<strong>${esc(d.actorName || d.actorEmail)}</strong> (${esc(d.actorEmail)}) asked to restore Agency OS to the backup from <strong>${esc(fmtTime(d.backupAt))}</strong>.`) +
      box(`Asked at ${esc(fmtTime(d.at))}<br/>IP: ${esc(String(d.ip || '').slice(0, 64))}<br/>Browser: ${esc(String(d.userAgent || '').slice(0, 120))}`) +
      p('No action is needed unless this is unexpected. If it is, change your password and contact the other owners right away.'),
    text: `${d.actorEmail} asked to restore Agency OS to the backup from ${fmtTime(d.backupAt)} (asked ${fmtTime(d.at)}, IP ${String(d.ip || '').slice(0, 64)}). No action needed unless this is unexpected.`,
  }),
  restoreCompleted: (d) => ({
    subject: 'Agency OS was restored',
    preheader: `Restored to the backup from ${fmtTime(d.backupAt)}.`,
    html:
      p(`Agency OS was restored to the backup from <strong>${esc(fmtTime(d.backupAt))}</strong> by ${esc(d.actorEmail)}. It took ${esc(Math.round((d.durationMs || 0) / 1000))} s.`) +
      box(`Safety backup (the state just before the restore): ${esc(d.safetyFile || 'none')} (${esc(fmtTime(d.safetyAt))}). It can undo this restore.`) +
      p('Everyone has been signed out. Sign in again with your current password.'),
    text: `Agency OS was restored to the backup from ${fmtTime(d.backupAt)} by ${d.actorEmail}. Safety backup: ${d.safetyFile || 'none'}. Everyone has to sign in again.`,
  }),
  restoreRolledBack: (d) => ({
    subject: 'OS restore failed and was rolled back',
    preheader: 'Nothing was lost: Agency OS is back to its state before the restore.',
    html:
      p(`The restore to the backup from ${esc(fmtTime(d.backupAt))} failed (${esc(d.error || 'error')}). Agency OS was rolled back to the safety backup taken just before it, so the data is as it was before the restore.`) +
      p('Everyone has been signed out. Sign in again.'),
    text: `The restore to ${fmtTime(d.backupAt)} failed (${d.error || 'error'}) and was rolled back to the safety backup. Everyone has to sign in again.`,
  }),
  restoreFailed: (d) =>
    d.rollbackFailed
      ? {
          subject: 'URGENT: OS restore and rollback failed',
          preheader: 'Agency OS is in maintenance. Run the commands below on the server.',
          html:
            p(`The restore failed (${esc(d.error || 'error')}) and the automatic rollback failed too. Agency OS stays in maintenance. Run these on the server (SSH):`) +
            box(CLI_FAILED_ROLLBACK(d.safetyFile).map(code).join('<br/>')),
          text: `The restore and the rollback failed (${d.error || 'error'}). Agency OS stays in maintenance. On the server:\n${CLI_FAILED_ROLLBACK(d.safetyFile).join('\n')}`,
        }
      : {
          subject: 'OS restore did not start: nothing changed',
          preheader: 'The restore stopped before changing any data.',
          html: p(`The restore to the backup from ${esc(fmtTime(d.backupAt))} stopped before any data changed (${esc(d.error || 'error')}). Agency OS is running normally.`),
          text: `The restore to ${fmtTime(d.backupAt)} stopped before any data changed (${d.error || 'error'}).`,
        },
  restoreNeedsMigration: (d) => ({
    subject: 'OS restored: run the database migration',
    preheader: 'Agency OS stays in maintenance until the migration runs.',
    html:
      p(`Agency OS was restored to the older backup from ${esc(fmtTime(d.backupAt))}. That backup predates ${esc(d.missingCount || 'some')} migration(s), so Agency OS stays in maintenance until you run:`) +
      box(code(CLI_MIGRATE)) +
      p('Then press "I ran migrate deploy" on the restore page (or sign in and open OS Backups).'),
    text: `Agency OS was restored to the older backup from ${fmtTime(d.backupAt)}. Run on the server:\n${CLI_MIGRATE}\nthen press "I ran migrate deploy" on the restore page.`,
  }),
  downloadOtp: (d) => ({
    subject: 'Your OS backup download code',
    preheader: 'Use this code to download the encrypted backup file.',
    html:
      p(`${esc(d.name || 'Hi')}, you asked to download the encrypted backup from <strong>${esc(fmtTime(d.backupAt))}</strong> (${esc(fmtBytes(d.backupBytes))}).`) +
      `<p style="margin:16px 0;font-size:28px;font-weight:700;letter-spacing:6px;">${esc(d.code)}</p>` +
      p('The code expires in 10 minutes and works once. The file is encrypted; it can only be read with OS_BACKUP_ENCRYPTION_KEY.') +
      p("<strong>Didn't request this?</strong> Change your password now and tell the other owners."),
    text: `Your OS backup download code: ${d.code}\nBackup: ${fmtTime(d.backupAt)}. Expires in 10 minutes, single use. Didn't request this? Change your password.`,
  }),
  downloadAlert: (d) => ({
    subject: 'An OS backup was downloaded',
    preheader: `${d.actorEmail} downloaded an encrypted backup.`,
    html:
      p(`<strong>${esc(d.actorEmail)}</strong> downloaded the encrypted backup from ${esc(fmtTime(d.backupAt))} (${esc(fmtBytes(d.backupBytes))}).`) +
      box(`At ${esc(fmtTime(d.at))}<br/>IP: ${esc(String(d.ip || '').slice(0, 64))}`) +
      p('No action is needed unless this is unexpected.'),
    text: `${d.actorEmail} downloaded the encrypted backup from ${fmtTime(d.backupAt)} at ${fmtTime(d.at)}.`,
  }),
  scheduleChanged: (d) => ({
    subject: d.paused ? 'OS backups were paused' : 'OS backups were resumed',
    preheader: `${d.actorEmail} ${d.paused ? 'paused' : 'resumed'} the 4-hourly backups.`,
    html: p(`${esc(d.actorEmail)} ${d.paused ? '<strong>paused</strong>' : 'resumed'} the scheduled OS backups at ${esc(fmtTime(d.at))}.${d.paused ? ' No new backups run until they are resumed.' : ''}`),
    text: `${d.actorEmail} ${d.paused ? 'paused' : 'resumed'} the scheduled OS backups at ${fmtTime(d.at)}.`,
  }),
  backupFailing: (d) => ({
    subject: 'OS backups are failing',
    preheader: `${d.failures} scheduled backups failed in a row.`,
    html: p(`${esc(d.failures)} scheduled OS backups failed in a row. Last error: ${code(d.error || 'unknown')}. The newest good backup is from ${esc(fmtTime(d.lastSuccessAt))}.`) + p('Open OS Backups in the admin portal to check the status.'),
    text: `${d.failures} scheduled OS backups failed in a row. Last error: ${d.error || 'unknown'}. Last good backup: ${fmtTime(d.lastSuccessAt)}.`,
  }),
  diskLow: (d) => ({
    subject: 'OS backups: disk space is low',
    preheader: 'Backups may stop until space is freed.',
    html: p(`Free space for OS backups is low: ${esc(fmtBytes(d.freeBytes))} free, ${esc(fmtBytes(d.requiredBytes))} needed. Backups will fail with DISK_LOW until space is freed or OS_BACKUP_MIN_FREE_MB / OS_BACKUP_QUOTA_MB are adjusted.`),
    text: `Free space for OS backups is low: ${fmtBytes(d.freeBytes)} free, ${fmtBytes(d.requiredBytes)} needed.`,
  }),
  backupStale: (d) => ({
    subject: 'OS backups are stale',
    preheader: 'No good backup for more than 9 hours.',
    html: p(`There has been no successful OS backup for more than 9 hours (newest: ${esc(fmtTime(d.lastSuccessAt))}). Check OS Backups in the admin portal.`),
    text: `No successful OS backup for more than 9 hours (newest: ${fmtTime(d.lastSuccessAt)}).`,
  }),
};

/** Full HTML with the branded layout, from a template. `settings` given = no DB read. */
export async function render(name, data, settings) {
  const t = templates[name](data);
  const html = await wrapInBrandedLayout({ bodyHtml: t.html, preheader: t.preheader, category: 'security', actionUrl: data.actionUrl, actionLabel: data.actionLabel || 'Open OS Backups', settings });
  return { subject: t.subject, html, text: t.text };
}

/** Send one template to each recipient (one message each, no shared To). Returns the count sent. */
export async function sendTemplate(name, data, recipients, { settings, send = sendEmail } = {}) {
  let sent = 0;
  for (const r of recipients || []) {
    if (!r?.email) continue;
    const msg = await render(name, { ...data, name: r.name }, settings);
    const res = await send({ to: r.email, ...msg }).catch(() => ({ success: false }));
    if (res?.success) sent += 1;
  }
  return sent;
}

export const osBackupsUrl = () => `${APP_URL()}/portal/admin/os-backups`;
export const restorePageUrl = (jobId) => `${APP_URL()}/os-restore/${jobId}`;
