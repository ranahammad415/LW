/**
 * Client-facing interview emails (plan §11, §17, §19, §20).
 *
 * These go to people who are often not `User` rows, so they use sendEmail +
 * wrapInBrandedLayout directly rather than notify(). They are sent in the
 * agency's name (owner decision D9) and never include a transcript (D2).
 *
 * Every builder returns {subject, html, text}. The token link appears only in
 * the button and once in the plain text — never in the subject.
 */
import { wrapInBrandedLayout, getAgencySettings } from './emailLayout.js';
import { folderLabel } from './interviewQuestionBank.js';

const MAX_EMAIL_TOPICS = 8;

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clip(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function formatDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** The agency's display name (D9). */
export async function agencyDisplayName() {
  const s = await getAgencySettings();
  return s?.emailFromName || s?.agencyName || 'Localwaves';
}

/**
 * Groups agenda questions into short topic lines by folder label.
 * @param {object} agenda
 * @param {{questionIds?: string[]|null, max?: number}} [opts]
 * @returns {Array<{label: string, topics: string[]}>}
 */
export function groupAgendaTopics(agenda, { questionIds = null, max = MAX_EMAIL_TOPICS } = {}) {
  const wanted = questionIds ? new Set(questionIds) : null;
  const questions = (agenda?.questions || [])
    .filter((q) => (wanted ? wanted.has(q.id) : q.kind !== 'followup'))
    .filter((q) => wanted || !q.delegatedTo)
    .slice(0, max);
  const groups = new Map();
  for (const q of questions) {
    const label = folderLabel(q.folder);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(clip(q.topic || q.prompt, 110));
  }
  return [...groups.entries()].map(([label, topics]) => ({ label, topics }));
}

function topicsHtml(groups) {
  if (!groups.length) return '';
  return groups
    .map(
      (g) => `<p style="margin:12px 0 4px;font-weight:600;">${escapeHtml(g.label)}</p>
<ul style="margin:0 0 4px 18px;padding:0;">${g.topics.map((t) => `<li style="margin:2px 0;">${escapeHtml(t)}</li>`).join('')}</ul>`
    )
    .join('');
}

function topicsText(groups) {
  return groups.map((g) => `${g.label}:\n${g.topics.map((t) => `  - ${t}`).join('\n')}`).join('\n');
}

function paragraphs(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

/**
 * Invite or reminder email for a root respondent (or a worker reminder).
 */
export async function buildInviteEmail({
  invite,
  businessName,
  agencyName,
  url,
  isReminder = false,
}) {
  const agenda = invite.agenda || {};
  const groups = groupAgendaTopics(agenda, {
    questionIds: invite.respondentRole === 'STAFF' && Array.isArray(invite.questionCluster)
      ? invite.questionCluster.map((q) => q.id)
      : null,
  });
  const minutes = Math.max(3, Math.min(Number(agenda.estMinutes) || Number(invite.minutesBudget) || 10, 30));
  const goal = clip(agenda.goals?.[0] || 'Help us get the details right so everything we write for you is accurate.', 200);
  const name = invite.recipientName ? ` ${invite.recipientName}` : '';
  const expiry = formatDate(invite.expiresAt);
  const canDelegate = invite.respondentRole !== 'STAFF';

  const subject = clip(
    invite.emailSubject
      || (isReminder
        ? `Reminder: a few quick questions about ${businessName}`
        : `A few quick questions about ${businessName}`),
    200
  );

  const intro = invite.emailIntro
    ? paragraphs(invite.emailIntro)
    : `<p>${escapeHtml(goal)}</p>`;

  const bodyHtml = `<p>Hi${escapeHtml(name)},</p>
${isReminder ? `<p>A quick reminder from ${escapeHtml(agencyName)} — your interview link is still open.</p>` : ''}
${intro}
${groups.length ? `<p style="margin:16px 0 0;font-weight:700;">What we'll talk about</p>${topicsHtml(groups)}` : ''}
<p style="margin-top:16px;">It takes about <strong>${minutes} minutes</strong>. You can talk to our AI assistant or type your answers — your phone is fine.</p>
${canDelegate ? '<p>Can\'t answer some of these? You can hand them to a colleague from the link.</p>' : ''}
<p style="color:#64748b;font-size:13px;">The link works without a login and expires on ${escapeHtml(expiry)}. Your answers are reviewed by ${escapeHtml(agencyName)} before anything is used.</p>`;

  const html = await wrapInBrandedLayout({
    bodyHtml,
    preheader: clip(`${goal} About ${minutes} minutes.`, 140),
    actionUrl: url,
    actionLabel: 'Start interview',
    category: 'interview',
  });

  const text = [
    `Hi${name},`,
    '',
    isReminder ? `A quick reminder from ${agencyName} — your interview link is still open.\n` : null,
    invite.emailIntro ? String(invite.emailIntro).trim() : goal,
    '',
    groups.length ? `What we'll talk about:\n${topicsText(groups)}\n` : null,
    `It takes about ${minutes} minutes. You can talk to our AI assistant or type your answers.`,
    canDelegate ? "Can't answer some of these? You can hand them to a colleague from the link." : null,
    '',
    `Start the interview (no login needed): ${url}`,
    '',
    `The link expires on ${expiry}. Your answers are reviewed by ${agencyName} before anything is used.`,
  ]
    .filter((l) => l !== null)
    .join('\n');

  return { subject, html, text };
}

/**
 * Email to a colleague the client handed questions to (plan §19).
 */
export async function buildDelegationEmail({
  child,
  businessName,
  agencyName,
  delegatorName,
  url,
  declineUrl,
}) {
  const cluster = Array.isArray(child.questionCluster) ? child.questionCluster : [];
  const groups = groupAgendaTopics({ questions: cluster }, { questionIds: cluster.map((q) => q.id), max: 10 });
  const count = cluster.length;
  const minutes = Math.max(3, Math.min(Math.round(count * 1.2) || 5, Number(child.minutesBudget) || 10));
  const reason = clip(child.delegationReason || '', 300);
  const who = delegatorName || 'Your colleague';
  const name = child.recipientName ? ` ${child.recipientName}` : '';

  const subject = clip(
    `${who} asked for your help with ${businessName} (${count} quick question${count === 1 ? '' : 's'})`,
    200
  );

  const bodyHtml = `<p>Hi${escapeHtml(name)},</p>
<p><strong>${escapeHtml(who)}</strong> from ${escapeHtml(businessName)} thinks you are the best person to answer a few questions${reason ? `:</p><blockquote style="margin:8px 0;padding:8px 12px;border-left:3px solid #e2e8f0;color:#475569;">${escapeHtml(reason)}</blockquote>` : '.</p>'}
<p>${escapeHtml(agencyName)} is the marketing agency for ${escapeHtml(businessName)}. Your answers help them describe the business accurately.</p>
${groups.length ? `<p style="margin:16px 0 0;font-weight:700;">The questions</p>${topicsHtml(groups)}` : ''}
<p style="margin-top:16px;">It takes about <strong>${minutes} minutes</strong>, by voice or typing. ${escapeHtml(who)} and ${escapeHtml(agencyName)} will see your answers.</p>
<p style="color:#64748b;font-size:13px;">The link works without a login and expires on ${escapeHtml(formatDate(child.expiresAt))}.
Not you, or not the right person? <a href="${escapeHtml(declineUrl)}" style="color:#64748b;">Let them know</a>.</p>`;

  const html = await wrapInBrandedLayout({
    bodyHtml,
    preheader: clip(`${who} asked for your help with ${count} quick questions.`, 140),
    actionUrl: url,
    actionLabel: 'Start interview',
    category: 'interview',
  });

  const text = [
    `Hi${name},`,
    '',
    `${who} from ${businessName} thinks you are the best person to answer a few questions.`,
    reason ? `"${reason}"` : null,
    '',
    `${agencyName} is the marketing agency for ${businessName}.`,
    '',
    groups.length ? `The questions:\n${topicsText(groups)}\n` : null,
    `It takes about ${minutes} minutes, by voice or typing. ${who} and ${agencyName} will see your answers.`,
    '',
    `Start (no login needed): ${url}`,
    '',
    `Not you, or not the right person? ${declineUrl}`,
  ]
    .filter((l) => l !== null)
    .join('\n');

  return { subject, html, text };
}

/**
 * Completion summary to the root respondent (plan §20, D2: summary only,
 * never the transcript; D4: worker captures in full, never worker emails).
 *
 * @param {object} p
 * @param {Array<{title,folder,proposedBody,respondentName,respondentRole,changeKind,status,proposedMetadata}>} p.captures
 * @param {Array<{recipientName,respondentJobRole,status}>} p.children
 * @param {Array<{topic,prompt}>} p.openQuestions
 */
export async function buildSummaryEmail({
  root,
  businessName,
  agencyName,
  url,
  captures = [],
  children = [],
  openQuestions = [],
}) {
  const visible = captures.filter((c) => c.status !== 'REJECTED');
  const changes = visible.filter((c) => c.proposedMetadata?.change);
  const facts = visible.filter((c) => !c.proposedMetadata?.change);

  const byFolder = new Map();
  for (const c of facts) {
    const label = folderLabel(c.folder);
    if (!byFolder.has(label)) byFolder.set(label, []);
    byFolder.get(label).push(c);
  }

  const factHtml = [...byFolder.entries()]
    .map(([label, list]) => `<p style="margin:12px 0 4px;font-weight:600;">${escapeHtml(label)}</p>
<ul style="margin:0 0 4px 18px;padding:0;">${list
      .slice(0, 20)
      .map((c) => `<li style="margin:4px 0;"><strong>${escapeHtml(clip(c.title, 120))}</strong>${c.respondentRole === 'STAFF' && c.respondentName ? ` <span style="color:#64748b;">(from ${escapeHtml(c.respondentName)})</span>` : ''}<br/><span style="color:#475569;">${escapeHtml(clip(String(c.proposedBody || '').replace(/^#+\s*/gm, ''), c.respondentRole === 'STAFF' ? 600 : 220))}</span></li>`)
      .join('')}</ul>`)
    .join('');

  const changeHtml = changes.length
    ? `<p style="margin:16px 0 4px;font-weight:700;">Changes you confirmed</p><ul style="margin:0 0 4px 18px;padding:0;">${changes
      .map((c) => {
        const ch = c.proposedMetadata.change;
        return `<li>${escapeHtml(clip(ch.field, 80))}: ${escapeHtml(clip(ch.old_value, 120))} → <strong>${escapeHtml(clip(ch.new_value, 120))}</strong></li>`;
      })
      .join('')}</ul>`
    : '';

  const childHtml = children.length
    ? `<p style="margin:16px 0 4px;font-weight:700;">Handed to colleagues</p><ul style="margin:0 0 4px 18px;padding:0;">${children
      .map((c) => `<li>${escapeHtml(c.recipientName || 'A colleague')}${c.respondentJobRole ? ` (${escapeHtml(c.respondentJobRole)})` : ''} — ${escapeHtml(childStatusLabel(c.status))}</li>`)
      .join('')}</ul>`
    : '';

  const openHtml = openQuestions.length
    ? `<p style="margin:16px 0 4px;font-weight:700;">Still open</p><ul style="margin:0 0 4px 18px;padding:0;">${openQuestions
      .slice(0, 8)
      .map((q) => `<li>${escapeHtml(clip(q.topic || q.prompt, 110))}</li>`)
      .join('')}</ul>`
    : '';

  const name = root.recipientName ? ` ${root.recipientName}` : '';
  const subject = clip(`Thanks — here's what we captured about ${businessName}`, 200);
  const bodyHtml = `<p>Hi${escapeHtml(name)},</p>
<p>Thank you for your time. Here is a summary of what we captured. ${escapeHtml(agencyName)} will review everything before it is used.</p>
${factHtml || '<p>No new facts were captured.</p>'}
${changeHtml}
${childHtml}
${openHtml}
<p style="margin-top:16px;">Spotted something wrong? Use the button to correct or remove it. The link stays open for 30 days.</p>`;

  const html = await wrapInBrandedLayout({
    bodyHtml,
    preheader: clip(`${visible.length} item(s) captured. Correct anything that is wrong.`, 140),
    actionUrl: url,
    actionLabel: 'Correct it',
    category: 'interview',
  });

  const text = [
    `Hi${name},`,
    '',
    `Thank you for your time. Here is a summary of what we captured. ${agencyName} will review everything before it is used.`,
    '',
    ...[...byFolder.entries()].map(([label, list]) => `${label}:\n${list.slice(0, 20).map((c) => `  - ${clip(c.title, 120)}${c.respondentRole === 'STAFF' && c.respondentName ? ` (from ${c.respondentName})` : ''}: ${clip(String(c.proposedBody || '').replace(/^#+\s*/gm, ''), 220)}`).join('\n')}`),
    changes.length ? `\nChanges you confirmed:\n${changes.map((c) => `  - ${c.proposedMetadata.change.field}: ${c.proposedMetadata.change.old_value} -> ${c.proposedMetadata.change.new_value}`).join('\n')}` : null,
    children.length ? `\nHanded to colleagues:\n${children.map((c) => `  - ${c.recipientName || 'A colleague'} — ${childStatusLabel(c.status)}`).join('\n')}` : null,
    openQuestions.length ? `\nStill open:\n${openQuestions.slice(0, 8).map((q) => `  - ${clip(q.topic || q.prompt, 110)}`).join('\n')}` : null,
    '',
    `Correct or remove anything (link open for 30 days): ${url}`,
  ]
    .filter((l) => l !== null)
    .join('\n');

  return { subject, html, text };
}

export function childStatusLabel(status) {
  switch (status) {
    case 'COMPLETED':
      return 'answered';
    case 'DECLINED':
      return 'declined';
    case 'EXPIRED':
      return 'did not answer in time';
    case 'REVOKED':
      return 'cancelled';
    case 'IN_PROGRESS':
    case 'OPENED':
      return 'in progress';
    default:
      return 'waiting';
  }
}
