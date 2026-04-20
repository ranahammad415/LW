/**
 * Reusable email-safe HTML component library for Localwaves notifications.
 *
 * All components use table-based layout with inline styles for maximum
 * email client compatibility (Gmail, Outlook, Apple Mail, etc.).
 */

const BRAND_PRIMARY = '#6366f1';
const BRAND_DARK    = '#4338ca';
const BRAND_TEXT    = '#1e293b';
const BRAND_MUTED   = '#64748b';
const BRAND_BORDER  = '#e2e8f0';
const BRAND_BG_LIGHT = '#f8fafc';
const FONT_STACK    = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

// Deterministic colour palette for avatar circles (12 distinct colors)
const AVATAR_COLORS = [
  '#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6',
  '#ef4444', '#14b8a6', '#f97316', '#06b6d4', '#84cc16', '#e11d48',
];

function hashName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash) + name.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return parts[0].slice(0, 2).toUpperCase();
}

// ─── Avatar Circle ──────────────────────────────────────────────────────────

/**
 * Colored circle with user initials — like Asana's RH / MS badges.
 * @param {string} name - User's display name
 * @param {number} [size=40] - Diameter in px
 * @returns {string} HTML
 */
export function avatarCircle(name, size = 40) {
  const initials = getInitials(name);
  const bg = AVATAR_COLORS[hashName(name || '?') % AVATAR_COLORS.length];
  const fontSize = Math.round(size * 0.42);
  return `<td style="width:${size}px;vertical-align:middle;">
  <div style="width:${size}px;height:${size}px;border-radius:50%;background:${bg};color:#ffffff;font-family:${FONT_STACK};font-size:${fontSize}px;font-weight:700;line-height:${size}px;text-align:center;letter-spacing:0.5px;">${initials}</div>
</td>`;
}

/**
 * Small inline avatar (for assignee lists, comment threads).
 */
export function avatarSmall(name, size = 28) {
  return avatarCircle(name, size);
}

// ─── Action Header ──────────────────────────────────────────────────────────

/**
 * Renders the "Person did X" header with avatar — mirrors Asana's pattern.
 *
 * @param {object} opts
 * @param {string} opts.actorName    - "Hamza"
 * @param {string} opts.actionText   - "added a comment"
 * @param {string} [opts.contextLine] - "SEO Agency – Hammad" (project/workspace)
 * @returns {string} HTML
 */
export function actionHeader({ actorName, actionText, contextLine }) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
  <tr>
    ${avatarCircle(actorName, 44)}
    <td style="padding-left:14px;vertical-align:middle;font-family:${FONT_STACK};">
      <div style="font-size:17px;font-weight:600;color:${BRAND_TEXT};line-height:1.3;">
        ${escHtml(actorName)} <span style="font-weight:400;">${escHtml(actionText)}</span>
      </div>
      ${contextLine ? `<div style="font-size:13px;color:${BRAND_MUTED};margin-top:2px;">${escHtml(contextLine)}</div>` : ''}
    </td>
  </tr>
</table>`;
}

// ─── CTA Button ─────────────────────────────────────────────────────────────

/**
 * Primary call-to-action button.
 */
export function ctaButton(url, label = 'View task') {
  if (!url) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0 24px;">
  <tr>
    <td style="border-radius:6px;background:${BRAND_PRIMARY};">
      <a href="${escAttr(url)}" target="_blank" style="display:inline-block;padding:10px 24px;font-family:${FONT_STACK};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">${escHtml(label)}</a>
    </td>
  </tr>
</table>`;
}

// ─── Comment Block ──────────────────────────────────────────────────────────

/**
 * Renders the primary comment/message text (the one the actor just posted).
 */
export function commentBlock(authorName, text) {
  if (!text) return '';
  // If the text contains @mentions render them highlighted
  const rendered = escHtml(text).replace(
    /@([A-Z][a-z]+(?:\s[A-Z][a-z]+)+)/g,
    '<span style="color:' + BRAND_PRIMARY + ';font-weight:600;">$&</span>'
  );
  return `<div style="margin:0 0 20px;">
  <div style="font-family:${FONT_STACK};font-size:13px;color:${BRAND_PRIMARY};font-weight:600;margin-bottom:4px;">${escHtml(authorName)}</div>
  <div style="font-family:${FONT_STACK};font-size:15px;color:${BRAND_TEXT};line-height:1.55;">${rendered}</div>
</div>`;
}

// ─── Task Detail Card ───────────────────────────────────────────────────────

/**
 * Rich task card — mirrors Asana's embedded task detail box.
 *
 * @param {object} task
 * @param {string} task.title
 * @param {string} [task.status]
 * @param {string} [task.dueDate]   - ISO string or formatted date
 * @param {string} [task.projectName]
 * @param {string} [task.projectColor] - hex colour for dot (default indigo)
 * @param {Array}  [task.assignees] - [{ name }]
 * @param {string} [task.description] - first ~150 chars
 * @param {string} [task.url]       - link to full task
 * @returns {string} HTML
 */
export function taskDetailCard(task) {
  if (!task) return '';
  const statusIcons = {
    COMPLETED: '&#9989;',    // green check
    IN_PROGRESS: '&#9654;',  // play
    TO_DO: '&#9675;',        // circle
    NEEDS_REVIEW: '&#128269;', // magnifier
  };
  const statusIcon = statusIcons[task.status] || '&#9675;';
  const projColor = task.projectColor || BRAND_PRIMARY;

  const dueDateRow = task.dueDate
    ? `<tr>
        <td style="padding:6px 16px;font-family:${FONT_STACK};font-size:13px;color:${BRAND_MUTED};vertical-align:middle;">
          <span style="margin-right:6px;">&#128197;</span> Due date: ${escHtml(formatDate(task.dueDate))}
        </td>
      </tr>`
    : '';

  const projectRow = task.projectName
    ? `<tr>
        <td style="padding:6px 16px;font-family:${FONT_STACK};font-size:13px;color:${BRAND_MUTED};vertical-align:middle;">
          <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${projColor};margin-right:6px;vertical-align:middle;"></span>${escHtml(task.projectName)}
        </td>
      </tr>`
    : '';

  const assigneesRow = task.assignees && task.assignees.length > 0
    ? `<tr>
        <td style="padding:6px 16px;font-family:${FONT_STACK};font-size:13px;color:${BRAND_MUTED};vertical-align:middle;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="padding-right:6px;vertical-align:middle;"><span style="margin-right:4px;">&#128101;</span></td>
            <td style="vertical-align:middle;font-family:${FONT_STACK};font-size:13px;color:${BRAND_MUTED};">
              ${task.assignees.map(a => escHtml(a.name)).join(', ')}
            </td>
          </tr></table>
        </td>
      </tr>`
    : '';

  const descRow = task.description
    ? `<tr>
        <td style="padding:8px 16px;font-family:${FONT_STACK};font-size:13px;color:${BRAND_MUTED};line-height:1.45;border-top:1px solid ${BRAND_BORDER};">
          <span style="margin-right:4px;">&#9776;</span> ${escHtml(task.description.slice(0, 150))}${task.description.length > 150 ? '...' : ''}
        </td>
      </tr>`
    : '';

  const viewLink = task.url
    ? `<tr>
        <td style="padding:8px 16px 12px;font-family:${FONT_STACK};">
          <a href="${escAttr(task.url)}" style="font-size:13px;color:${BRAND_PRIMARY};text-decoration:none;font-weight:500;">View full task details</a>
        </td>
      </tr>`
    : '';

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BRAND_BORDER};border-radius:8px;margin:16px 0;overflow:hidden;">
  <tr>
    <td style="padding:14px 16px 8px;font-family:${FONT_STACK};font-size:15px;font-weight:600;color:${BRAND_TEXT};">
      <span style="margin-right:6px;">${statusIcon}</span> ${task.url ? `<a href="${escAttr(task.url)}" style="color:${BRAND_PRIMARY};text-decoration:none;">${escHtml(task.title)}</a>` : escHtml(task.title)}
    </td>
  </tr>
  ${dueDateRow}
  ${projectRow}
  ${assigneesRow}
  ${descRow}
  ${viewLink}
</table>`;
}

// ─── Issue Detail Card ──────────────────────────────────────────────────────

/**
 * Issue card — similar structure to task card but for support issues.
 */
export function issueDetailCard(issue) {
  if (!issue) return '';
  const priorityColors = { HIGH: '#ef4444', CRITICAL: '#dc2626', MEDIUM: '#f59e0b', LOW: '#10b981' };
  const prioColor = priorityColors[issue.priority] || BRAND_MUTED;

  const statusRow = issue.status
    ? `<tr><td style="padding:6px 16px;font-family:${FONT_STACK};font-size:13px;color:${BRAND_MUTED};">Status: <strong style="color:${BRAND_TEXT};">${escHtml(issue.status)}</strong></td></tr>`
    : '';

  const priorityRow = issue.priority
    ? `<tr><td style="padding:6px 16px;font-family:${FONT_STACK};font-size:13px;color:${BRAND_MUTED};">Priority: <strong style="color:${prioColor};">${escHtml(issue.priority)}</strong></td></tr>`
    : '';

  const assigneeRow = issue.assigneeName
    ? `<tr><td style="padding:6px 16px;font-family:${FONT_STACK};font-size:13px;color:${BRAND_MUTED};">&#128101; Assigned to: ${escHtml(issue.assigneeName)}</td></tr>`
    : '';

  const descRow = issue.description
    ? `<tr><td style="padding:8px 16px;font-family:${FONT_STACK};font-size:13px;color:${BRAND_MUTED};line-height:1.45;border-top:1px solid ${BRAND_BORDER};">&#9776; ${escHtml(issue.description.slice(0, 150))}${issue.description.length > 150 ? '...' : ''}</td></tr>`
    : '';

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BRAND_BORDER};border-radius:8px;margin:16px 0;overflow:hidden;">
  <tr>
    <td style="padding:14px 16px 8px;font-family:${FONT_STACK};font-size:15px;font-weight:600;color:${BRAND_TEXT};">
      &#9888; ${escHtml(issue.title)}
    </td>
  </tr>
  ${statusRow}
  ${priorityRow}
  ${assigneeRow}
  ${descRow}
</table>`;
}

// ─── Comment Thread ─────────────────────────────────────────────────────────

/**
 * "Recent comments" section — list of comments with avatar + name + time.
 *
 * @param {Array} comments - [{ authorName, content, createdAt }]
 * @returns {string} HTML
 */
export function commentThread(comments) {
  if (!comments || comments.length === 0) return '';

  const rows = comments.map((c) => {
    const timeStr = formatTime(c.createdAt);
    const content = escHtml(c.content.slice(0, 300)).replace(
      /@([A-Z][a-z]+(?:\s[A-Z][a-z]+)+)/g,
      '<span style="color:' + BRAND_PRIMARY + ';font-weight:600;">$&</span>'
    );
    return `<tr>
      <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            ${avatarSmall(c.authorName, 26)}
            <td style="padding-left:10px;vertical-align:top;font-family:${FONT_STACK};">
              <div style="font-size:13px;font-weight:600;color:${BRAND_TEXT};display:inline;">${escHtml(c.authorName)}</div>
              <span style="font-size:12px;color:${BRAND_MUTED};margin-left:6px;">${timeStr}</span>
              <div style="font-size:14px;color:${BRAND_TEXT};line-height:1.5;margin-top:3px;">${content}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
  }).join('');

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 8px;">
  <tr>
    <td style="font-family:${FONT_STACK};font-size:13px;font-weight:600;color:${BRAND_MUTED};text-transform:uppercase;letter-spacing:0.5px;padding-bottom:8px;border-bottom:1px solid ${BRAND_BORDER};">Recent comments</td>
  </tr>
  ${rows}
</table>`;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(str) {
  return escHtml(str);
}

function formatDate(d) {
  try {
    const dt = typeof d === 'string' ? new Date(d) : d;
    if (isNaN(dt.getTime())) return String(d);
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return String(d); }
}

function formatTime(d) {
  try {
    const dt = typeof d === 'string' ? new Date(d) : d;
    if (isNaN(dt.getTime())) return '';
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' at ' + dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  } catch { return ''; }
}
