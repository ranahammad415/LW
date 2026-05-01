/**
 * Password reset email helper. Builds a branded HTML + plain-text email
 * containing a magic-link reset URL and sends it via the existing mailer.
 *
 * SECURITY: only the plaintext token is included in the email; the DB
 * stores only the SHA-256 hash. Token TTL is enforced server-side.
 */
import { sendEmail } from './mailer.js';
import { wrapInBrandedLayout } from './emailLayout.js';

const APP_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const TTL_MINUTES = 60;

/**
 * Send the reset-password email.
 *
 * @param {{ to: string, name?: string, token: string }} opts
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function sendPasswordResetEmail({ to, name, token }) {
  const resetUrl = `${APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
  const safeName = (name && name.trim()) || 'there';
  const subject = 'Reset your Localwaves password';

  const bodyHtml = `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0;padding:0;">
      <tr>
        <td style="padding:0 24px 16px 24px;">
          <h2 style="margin:0 0 12px 0;font-size:20px;color:#1e293b;font-weight:600;">Hi ${escapeHtml(safeName)},</h2>
          <p style="margin:0 0 16px 0;font-size:14px;line-height:1.5;color:#334155;">
            We received a request to reset the password for your Localwaves account.
            Click the button below to choose a new one.
          </p>
        </td>
      </tr>
      <tr>
        <td align="center" style="padding:8px 24px 24px 24px;">
          <a href="${resetUrl}"
             style="display:inline-block;padding:12px 28px;background:#6366f1;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">
            Reset password
          </a>
        </td>
      </tr>
      <tr>
        <td style="padding:0 24px 24px 24px;">
          <p style="margin:0 0 8px 0;font-size:12px;line-height:1.5;color:#64748b;">
            Or copy and paste this URL into your browser:
          </p>
          <p style="margin:0 0 16px 0;font-size:12px;line-height:1.5;color:#475569;word-break:break-all;">
            <a href="${resetUrl}" style="color:#4338ca;text-decoration:underline;">${resetUrl}</a>
          </p>
          <p style="margin:0;font-size:12px;line-height:1.5;color:#64748b;">
            This link will expire in ${TTL_MINUTES} minutes and can be used only once.
            If you didn't request a password reset, you can safely ignore this email — your
            password will not be changed.
          </p>
        </td>
      </tr>
    </table>
  `;

  const html = await wrapInBrandedLayout({
    bodyHtml,
    preheader: 'Reset your Localwaves password',
    actionUrl: resetUrl,
    actionLabel: 'Reset password',
    category: 'client',
  });

  const text =
    `Hi ${safeName},\n\n` +
    `We received a request to reset your Localwaves password.\n` +
    `Open this link to choose a new password (valid for ${TTL_MINUTES} minutes, one-time use):\n\n` +
    `${resetUrl}\n\n` +
    `If you didn't request this, ignore this email — your password will not be changed.`;

  return sendEmail({ to, subject, html, text });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
