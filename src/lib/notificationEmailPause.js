/**
 * Global outbound notification-email pause.
 * When true, notify() / notifyTest() / deferred emails skip SMTP but leave
 * templates, prefs, and SMTP config untouched. Password-reset and Admin SMTP
 * test bypass this (they call sendEmail directly).
 */
export function notificationEmailsPaused() {
  const v = String(process.env.NOTIFICATION_EMAILS_PAUSED || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export const PAUSED_EMAIL_ERROR = 'Paused — NOTIFICATION_EMAILS_PAUSED';
