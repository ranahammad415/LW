/**
 * The AI-led expert interview.
 *
 * The model is given a briefing built from the client's own website and
 * knowledge base, then runs a text conversation one turn at a time. Anything it
 * learns is filed as a PENDING OkfDraftChange while the interview is still
 * running, so the knowledge base fills up as the client answers rather than in
 * one lump at the end.
 *
 * Nothing here writes to disk. Approval stays with the existing OKF review
 * queue, which is the only path into knowledge_base/.
 */
import { prisma } from './prisma.js';
import { generateChat } from './ai.js';
import { renderBriefingForPrompt } from './interviewBriefing.js';

/** Folders a capture may target. Mirrors the voice agent's save_business_fact. */
export const CAPTURE_FOLDERS = [
  'company',
  'services',
  'locations',
  'competitors',
  'faq',
  'proof',
  'voice',
  'seo/strategy',
];

export const INTERVIEW_SOURCE_TYPE = 'EXPERT_INTERVIEW';

/** Turns kept in the model's context. Older turns are summarised out by length. */
const MAX_TRANSCRIPT_TURNS = 40;
const MAX_ANSWER_CHARS = 4000;

function slugify(text) {
  return (
    String(text || '')
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled'
  );
}

export function buildSystemPrompt(briefing, { seedTopic = null } = {}) {
  return `You are a senior business consultant at Localwave, a digital marketing agency, interviewing a client so the SEO and content team can write about them accurately.

You have already reviewed their business. Everything below is what we know today.

${renderBriefingForPrompt(briefing)}

${seedTopic ? `THE CLIENT ASKED TO START HERE\n${seedTopic}\nOpen on this, then widen out once it is covered.\n\n` : ''}HOW TO INTERVIEW
- Ask exactly one question per turn, in two sentences at most.
- Ground your questions in what you saw on their site. Prefer "your site lists emergency callouts but does not say what the response time is — what is it?" over "tell me about your services".
- Never re-ask something the knowledge base already answers. Confirm it briefly instead if you need to check it is current.
- When an answer is vague, push once for a number, a name, or a concrete example before moving on.
- Never invent facts, never guess at figures, and never put words in their mouth.
- Prioritise: anything missing from the knowledge base, then the known gaps above, then anything their website claims that we cannot back up.
- Set isFinished to true once the priorities are covered or the client wants to stop.

WHAT TO RECORD
Each turn, put anything concrete you just learned into "captures". A capture is a self-contained piece of knowledge written as Markdown, in the client's own words where you can.
- "folder" must be exactly one of: ${CAPTURE_FOLDERS.join(', ')}.
- "filename" is lowercase kebab-case with no extension, and should name the subject, e.g. "emergency-callout" or "brand-voice". Reuse the same filename across turns when you learn more about the same subject.
- "content" starts with a Markdown heading and holds only what the client actually said.
- "confidence" is 0 to 1: how clearly they stated it.
- Return an empty captures array when a turn taught you nothing concrete.
- Put anything they could not answer into "gaps" so the SEO team can follow up.

Everything you record is reviewed by a human before it reaches the knowledge base, so capture their meaning rather than polishing it.

Respond with JSON of exactly this shape:
{"nextQuestion":"...","captures":[{"folder":"services","filename":"emergency-callout","title":"Emergency callout response time","content":"# ...","confidence":0.8}],"gaps":[{"category":"proof","description":"..."}],"topicsCovered":["..."],"isFinished":false}`;
}

/** Drops anything the model got wrong rather than filing a malformed draft. */
export function coerceCaptures(raw) {
  if (!Array.isArray(raw)) return [];

  const captures = [];
  for (const c of raw) {
    const content = String(c?.content || '').trim();
    if (content.length < 20) continue;

    const folder = CAPTURE_FOLDERS.includes(c?.folder) ? c.folder : 'company';
    const title = String(c?.title || '').trim() || 'Interview note';

    captures.push({
      folder,
      filename: slugify(c?.filename || title).slice(0, 200),
      title: title.slice(0, 255),
      content,
      confidence:
        typeof c?.confidence === 'number' ? Math.min(1, Math.max(0, c.confidence)) : null,
    });
  }
  return captures;
}

function coerceGaps(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((g) => String(g?.description || '').trim())
    .map((g) => ({
      category: String(g.category || 'company').toLowerCase().slice(0, 40),
      description: String(g.description).trim().slice(0, 500),
    }))
    .slice(0, 10);
}

/**
 * One conversation turn.
 *
 * The transcript comes from the session row rather than the browser, so the
 * model always sees the message it is answering and a client cannot rewrite
 * its own history.
 */
export async function runInterviewTurn({
  briefing,
  transcript,
  message,
  seedTopic = null,
  clientId,
  userId,
}) {
  const recent = transcript.slice(-MAX_TRANSCRIPT_TURNS);
  const messages = [
    ...recent.map((t) => ({
      role: t.role === 'assistant' ? 'assistant' : 'user',
      content: String(t.content || '').slice(0, MAX_ANSWER_CHARS),
    })),
    { role: 'user', content: String(message).slice(0, MAX_ANSWER_CHARS) },
  ];

  const { parsed } = await generateChat({
    system: buildSystemPrompt(briefing, { seedTopic }),
    messages,
    json: true,
    maxTokens: 2048,
    feature: 'expert_interview_turn',
    userId,
    clientId,
  });

  if (!parsed) {
    // An unparseable turn should not end the interview; keep it moving and let
    // the next answer produce captures instead.
    return {
      nextQuestion: 'Sorry — could you say a little more about that?',
      captures: [],
      gaps: [],
      topicsCovered: [],
      isFinished: false,
    };
  }

  return {
    nextQuestion:
      String(parsed.nextQuestion || '').trim() || 'What else should we know about how you work?',
    captures: coerceCaptures(parsed.captures),
    gaps: coerceGaps(parsed.gaps),
    topicsCovered: Array.isArray(parsed.topicsCovered)
      ? parsed.topicsCovered.map((t) => String(t).slice(0, 120)).slice(0, 20)
      : [],
    isFinished: Boolean(parsed.isFinished),
  };
}

/**
 * Files captures against the session, one draft per destination file.
 *
 * A long interview will circle back to the same subject several times. Rather
 * than filing a row per answer — which leaves the reviewer approving fifteen
 * fragments of the same page — later captures are appended as sections to the
 * pending draft already targeting that file.
 *
 * @returns {Promise<Array<{folder:string,filename:string,title:string,confidence:number|null,isNew:boolean}>>}
 */
export async function upsertInterviewDrafts({ clientId, sessionId, captures }) {
  const results = [];

  for (const capture of captures) {
    const existing = await prisma.okfDraftChange.findFirst({
      where: {
        clientId,
        sessionId,
        folder: capture.folder,
        filename: capture.filename,
        status: 'PENDING',
      },
    });

    if (existing) {
      // Skip a capture the model has already filed verbatim, which happens when
      // it restates a fact while confirming it.
      const alreadyPresent = existing.proposedBody.includes(capture.content.trim());
      const body = alreadyPresent
        ? existing.proposedBody
        : `${existing.proposedBody.trimEnd()}\n\n## ${capture.title}\n\n${capture.content}`;

      const updated = await prisma.okfDraftChange.update({
        where: { id: existing.id },
        data: {
          proposedBody: body,
          confidence:
            capture.confidence != null
              ? Math.max(existing.confidence ?? 0, capture.confidence)
              : existing.confidence,
          proposedMetadata: {
            ...(existing.proposedMetadata || {}),
            updated_at: new Date().toISOString(),
          },
        },
      });

      results.push({
        folder: updated.folder,
        filename: updated.filename,
        title: updated.title,
        confidence: updated.confidence,
        isNew: false,
      });
      continue;
    }

    const created = await prisma.okfDraftChange.create({
      data: {
        clientId,
        sessionId,
        folder: capture.folder,
        filename: capture.filename,
        title: capture.title,
        proposedMetadata: {
          type: 'expert-interview',
          title: capture.title,
          source: INTERVIEW_SOURCE_TYPE,
          captured_at: new Date().toISOString(),
        },
        proposedBody: capture.content,
        sourceType: INTERVIEW_SOURCE_TYPE,
        confidence: capture.confidence,
        status: 'PENDING',
      },
    });

    results.push({
      folder: created.folder,
      filename: created.filename,
      title: created.title,
      confidence: created.confidence,
      isNew: true,
    });
  }

  return results;
}

/**
 * The opening question, so the interview starts on something specific rather
 * than "tell me about your business".
 */
export function buildOpeningQuestion(briefing, seedTopic = null) {
  if (seedTopic) return seedTopic;

  const name = briefing.business?.name || 'your business';
  const topGap = briefing.gaps?.items?.[0];
  if (topGap?.description) {
    return `Thanks for making time. Looking at ${name}, the biggest thing missing from our notes is ${topGap.description.replace(/\.$/, '')} — can you fill me in on that?`;
  }

  const firstPage = briefing.site?.pages?.[0];
  if (firstPage?.title) {
    return `Thanks for making time. I have read through your site — starting with "${firstPage.title}". Is that still the main thing you want customers to come to you for?`;
  }

  return `Thanks for making time. To start: in your own words, what does ${name} actually do, and who is it for?`;
}

/** The shortlist the briefing card shows before the first question. */
export function buildPlannedTopics(briefing) {
  const topics = [];
  const missing = briefing.coverage?.assessment?.missing || [];

  const labels = {
    'company/profile.md': 'What the business does and who it serves',
    'voice/brand-voice.md': 'How you want to sound in writing',
    'company/approved-claims.md': 'Claims we are allowed to make',
    'proof/testimonials.md or proof/case-studies.md': 'Proof: results, reviews and recent jobs',
  };
  for (const path of missing) {
    topics.push(labels[path] || path);
  }

  for (const gap of (briefing.gaps?.items || []).slice(0, 5)) {
    if (gap.description) topics.push(gap.description);
  }

  if (briefing.site?.source !== 'NONE') {
    topics.push('Detail behind the services your website already advertises');
  }
  topics.push('Anything that has changed recently');

  return [...new Set(topics)].slice(0, 8);
}
