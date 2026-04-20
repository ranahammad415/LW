import nodemailer from 'nodemailer';

const host = process.env.SMTP_HOST || '';
const port = parseInt(process.env.SMTP_PORT || '587', 10);
const user = process.env.SMTP_USER || '';
const pass = process.env.SMTP_PASS || '';
const fromName = process.env.SMTP_FROM_NAME || 'Agency OS';
const fromEmail = process.env.SMTP_FROM_EMAIL || 'noreply@yourdomain.com';

const smtpConfigured = !!(host && user && pass);

let transporter = null;

if (smtpConfigured) {
  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

/**
 * Send an email. No-ops gracefully if SMTP is not configured.
 * @param {{ to: string, subject: string, html: string, text?: string }} opts
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
export async function sendEmail({ to, subject, html, text }) {
  if (!smtpConfigured || !transporter) {
    // Silently skip — log only in development
    if (process.env.NODE_ENV === 'development') {
      console.log(`[mailer] SMTP not configured — skipping email to ${to}: ${subject}`);
    }
    return { success: false, error: 'SMTP not configured' };
  }

  try {
    const info = await transporter.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to,
      subject,
      html,
      text: text || undefined,
    });
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[mailer] Failed to send email to ${to}:`, err.message);
    return { success: false, error: err.message };
  }
}

export { smtpConfigured };
