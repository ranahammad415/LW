/**
 * Branded Localwaves email layout wrapper — Asana-style design.
 *
 * Structure:
 *   1. Logo header bar (Localwaves branding)
 *   2. Action header (avatar + "Person did X" + context line)
 *   3. CTA button ("View task") — immediately visible
 *   4. Body content (comment text, then task/issue card, then comment thread)
 *   5. Context-aware footer
 */

const BRAND_PRIMARY = '#6366f1';
const BRAND_DARK    = '#4338ca';
const BRAND_BG      = '#f8fafc';
const BRAND_TEXT    = '#1e293b';
const BRAND_MUTED   = '#64748b';
const FONT_STACK    = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

const LOGO_URL = 'https://app.localwaves.ai/favicon.png';
const APP_URL  = process.env.FRONTEND_URL || 'https://app.localwaves.ai';

// Context-aware footer messages by category
const FOOTER_MESSAGES = {
  task:         "Don't want emails about task updates?",
  pipeline:     "Don't want emails about content pipeline updates?",
  issue:        "Don't want emails about support issues?",
  client:       "Don't want emails about client updates?",
  client_input: "Don't want emails about client input?",
  keyword:      "Don't want emails about keyword updates?",
  project:      "Don't want emails about projects?",
  meeting:      "Don't want emails about meetings?",
  report:       "Don't want emails about reports?",
  standup:      "Don't want emails about standups?",
};

/**
 * Wrap notification content in the Asana-style branded Localwaves layout.
 *
 * @param {object} opts
 * @param {string} opts.bodyHtml          - Main rendered content HTML
 * @param {string} [opts.preheader]       - Hidden pre-header text for inbox previews
 * @param {string} [opts.actionUrl]       - CTA button URL
 * @param {string} [opts.actionLabel]     - CTA button text (default: "View task")
 * @param {string} [opts.category]        - Template category
 * @param {string} [opts.actionHeaderHtml]  - Rendered actionHeader() component
 * @param {string} [opts.commentBlockHtml]  - Rendered commentBlock() for the trigger comment
 * @param {string} [opts.detailCardHtml]    - Rendered taskDetailCard() or issueDetailCard()
 * @param {string} [opts.commentThreadHtml] - Rendered commentThread() for recent comments
 * @returns {string} Complete HTML email document
 */
export function wrapInBrandedLayout(opts = {}) {
  const {
    bodyHtml = '',
    preheader = '',
    actionUrl,
    actionLabel = 'View task',
    category,
    actionHeaderHtml = '',
    commentBlockHtml = '',
    detailCardHtml = '',
    commentThreadHtml = '',
  } = opts;

  const ctaButton = actionUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:12px 0 20px;">
        <tr>
          <td style="border-radius:6px;background:${BRAND_PRIMARY};">
            <a href="${actionUrl}" target="_blank" style="display:inline-block;padding:10px 24px;font-family:${FONT_STACK};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">${actionLabel}</a>
          </td>
        </tr>
      </table>`
    : '';

  // Context-aware footer message
  const footerMsg = (category && FOOTER_MESSAGES[category]) || "Don't want these emails?";

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>Localwaves Notification</title>
  <!--[if mso]>
  <style>body,table,td{font-family:Arial,Helvetica,sans-serif!important;}</style>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background-color:${BRAND_BG};-webkit-font-smoothing:antialiased;">
  ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${preheader}</div>` : ''}

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND_BG};">
    <tr>
      <td align="center" style="padding:32px 16px;">

        <!-- Email card -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.08);overflow:hidden;">

          <!-- Logo bar -->
          <tr>
            <td style="padding:20px 32px 16px;">
              <a href="${APP_URL}" target="_blank" style="text-decoration:none;">
                <img src="${LOGO_URL}" alt="Localwaves" width="28" height="28" style="width:28px;height:28px;border-radius:6px;margin-right:8px;vertical-align:middle;" />
                <span style="font-family:${FONT_STACK};font-size:18px;font-weight:700;color:${BRAND_DARK};vertical-align:middle;">Localwaves</span>
              </a>
            </td>
          </tr>

          <!-- Action header (avatar + "Person did X") -->
          ${actionHeaderHtml ? `<tr><td style="padding:8px 32px 0;font-family:${FONT_STACK};">${actionHeaderHtml}</td></tr>` : ''}

          <!-- CTA button — right after header like Asana -->
          ${ctaButton ? `<tr><td style="padding:0 32px;">${ctaButton}</td></tr>` : ''}

          <!-- Primary comment text (if this is a comment notification) -->
          ${commentBlockHtml ? `<tr><td style="padding:0 32px;font-family:${FONT_STACK};">${commentBlockHtml}</td></tr>` : ''}

          <!-- Body content (rendered template text, used when no rich components) -->
          ${bodyHtml && !actionHeaderHtml ? `<tr><td style="padding:16px 32px;font-family:${FONT_STACK};font-size:15px;line-height:1.6;color:${BRAND_TEXT};">${bodyHtml}</td></tr>` : ''}

          <!-- Task / Issue detail card -->
          ${detailCardHtml ? `<tr><td style="padding:0 32px;font-family:${FONT_STACK};">${detailCardHtml}</td></tr>` : ''}

          <!-- Recent comments thread -->
          ${commentThreadHtml ? `<tr><td style="padding:0 32px 16px;font-family:${FONT_STACK};">${commentThreadHtml}</td></tr>` : ''}

          <!-- Footer -->
          <tr>
            <td style="padding:20px 32px 24px;border-top:1px solid #e2e8f0;background:#f8fafc;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-family:${FONT_STACK};font-size:12px;color:${BRAND_MUTED};line-height:1.6;">
                    <p style="margin:0 0 4px;">${footerMsg} <a href="${APP_URL}/portal/settings" style="color:${BRAND_PRIMARY};text-decoration:none;font-weight:500;">Change what Localwaves sends you.</a></p>
                    <p style="margin:8px 0 0;font-size:11px;color:#94a3b8;">&copy; ${new Date().getFullYear()} Localwaves &middot; Intelligent Agency Platform</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}
