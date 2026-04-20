import { prisma } from './prisma.js';
import { sendEmail } from './mailer.js';

/**
 * In-memory email deferral queue.
 *
 * When a notification is dispatched the system creates the in-app alert
 * immediately but defers the email by DEFERRAL_MS.  If the user reads the
 * in-app notification before the timer fires, the email is skipped.
 */

const DEFERRAL_MS = 3 * 60 * 1000; // 3 minutes

// Map<jobId, timeoutHandle> — allows cancellation if needed in future
const pendingJobs = new Map();

/**
 * Schedule a deferred email send.
 *
 * @param {object} opts
 * @param {string} opts.logId      – NotificationLog id (to update after send)
 * @param {string} opts.alertId    – SystemAlert id (to check isRead)
 * @param {string} opts.to         – Recipient email address
 * @param {string} opts.subject    – Rendered subject
 * @param {string} opts.html       – Rendered HTML body (with branded layout)
 * @param {string} [opts.text]     – Rendered plain-text body
 */
export function deferEmail({ logId, alertId, to, subject, html, text }) {
  const jobId = logId; // use logId as unique key

  const handle = setTimeout(async () => {
    pendingJobs.delete(jobId);
    try {
      // Check if the user already read the in-app notification
      if (alertId) {
        const alert = await prisma.systemAlert.findUnique({
          where: { id: alertId },
          select: { isRead: true },
        });
        if (alert && alert.isRead) {
          // User saw it — skip email, update log
          await prisma.notificationLog.update({
            where: { id: logId },
            data: { emailError: 'Skipped — user read in-app notification', emailDeferred: false },
          }).catch(() => {});
          return;
        }
      }

      // User hasn't read it — send the email
      const result = await sendEmail({ to, subject, html, text });

      const update = { emailDeferred: false };
      if (result.success) {
        update.emailSentAt = new Date();
      } else {
        update.emailError = result.error || 'Unknown error';
      }
      await prisma.notificationLog.update({ where: { id: logId }, data: update }).catch(() => {});
    } catch (err) {
      console.error(`[emailDeferralQueue] Error processing deferred email (log ${logId}):`, err.message);
      await prisma.notificationLog.update({
        where: { id: logId },
        data: { emailDeferred: false, emailError: err.message?.slice(0, 500) },
      }).catch(() => {});
    }
  }, DEFERRAL_MS);

  pendingJobs.set(jobId, handle);
}

/**
 * Cancel a pending deferred email (e.g. if the user reads the alert via API).
 * @param {string} logId
 */
export function cancelDeferredEmail(logId) {
  const handle = pendingJobs.get(logId);
  if (handle) {
    clearTimeout(handle);
    pendingJobs.delete(logId);
  }
}

/** Number of currently pending deferred emails (useful for diagnostics). */
export function pendingCount() {
  return pendingJobs.size;
}
