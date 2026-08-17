/**
 * OpenAI Realtime API session minting for the browser voice agent.
 *
 * The browser never sees OPENAI_API_KEY. This module exchanges the server key
 * for a short-lived ephemeral client secret, which the browser then uses to
 * open a WebRTC connection directly to OpenAI.
 *
 * Required env:
 *   OPENAI_API_KEY
 * Optional env:
 *   OPENAI_REALTIME_MODEL                    default 'gpt-realtime'
 *   OPENAI_REALTIME_VOICE                    default 'marin'
 *   VOICE_AGENT_MAX_SESSION_SECONDS          default 900 (15 min)
 *   VOICE_AGENT_MONTHLY_MINUTES_PER_CLIENT   default 120
 */
import crypto from 'crypto';
import { assessOkfIntakeCompleteness } from './businessIntakeService.js';
import { readOkfFile, listClientFiles } from './knowledgeEngine.js';

const OPENAI_API_BASE = 'https://api.openai.com/v1';

const CLIENT_SECRETS_URL = `${OPENAI_API_BASE}/realtime/client_secrets`;

export const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
export const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || 'marin';
export const MAX_SESSION_SECONDS = Number(process.env.VOICE_AGENT_MAX_SESSION_SECONDS || 900);
export const MONTHLY_MINUTES_PER_CLIENT = Number(process.env.VOICE_AGENT_MONTHLY_MINUTES_PER_CLIENT || 120);

export function isRealtimeVoiceConfigured() {
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Tools the Realtime model can call mid-conversation. Everything the agent
 * captures lands in a review queue — none of these write to OKF directly.
 */
export const REALTIME_TOOLS = [
  {
    type: 'function',
    name: 'save_business_fact',
    description:
      'Record a specific, verified fact about the business that the client just told you. '
      + 'Call this as soon as you learn something concrete rather than waiting until the end. '
      + 'Never invent details — only record what the client actually said.',
    parameters: {
      type: 'object',
      properties: {
        folder: {
          type: 'string',
          description: 'Which part of the knowledge base this belongs in.',
          enum: ['company', 'services', 'locations', 'competitors', 'faq', 'proof', 'voice', 'seo/strategy'],
        },
        filename: {
          type: 'string',
          description: 'Kebab-case file name without extension, e.g. "emergency-callout" or "profile".',
        },
        title: { type: 'string', description: 'Short human-readable title for this fact.' },
        content: {
          type: 'string',
          description: 'The fact written as clean Markdown, in the client\'s own words where possible.',
        },
        confidence: {
          type: 'number',
          description: 'How certain you are the client stated this clearly, from 0 to 1.',
        },
      },
      required: ['folder', 'filename', 'title', 'content'],
    },
  },
  {
    type: 'function',
    name: 'flag_knowledge_gap',
    description:
      'Record that the client could not answer something, or that an important area is still undocumented. '
      + 'This tells the SEO team what to follow up on.',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Area of the business the gap relates to.',
          enum: ['company', 'services', 'locations', 'competitors', 'faq', 'proof', 'voice', 'seo'],
        },
        description: { type: 'string', description: 'What is missing and why it matters.' },
      },
      required: ['category', 'description'],
    },
  },
  {
    type: 'function',
    name: 'finish_interview',
    description: 'Call this once you have covered the priority topics and the client has nothing to add.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Two or three sentences summarising what you learned.' },
      },
      required: ['summary'],
    },
  },
];

function safeReadBody(clientId, folder, filename, maxChars = 900) {
  try {
    const doc = readOkfFile(clientId, folder, filename);
    const body = String(doc.body || '').trim();
    return body ? body.slice(0, maxChars) : null;
  } catch {
    return null;
  }
}

/**
 * Builds the agent's instructions from what is actually missing in this
 * client's knowledge base, so the interview targets real gaps instead of
 * re-asking questions we already have answers to.
 */
export function buildInterviewInstructions({ agencyName, clientId, websiteUrl, industry }) {
  const assessment = assessOkfIntakeCompleteness(clientId);

  let existingFiles = [];
  try {
    existingFiles = listClientFiles(clientId);
  } catch {
    existingFiles = [];
  }

  const knownProfile = safeReadBody(clientId, 'company', 'profile');
  const knownVoice = safeReadBody(clientId, 'voice', 'brand-voice', 400);

  const priorities = [];
  if (!assessment.profileComplete) {
    priorities.push('What the business actually does, who it serves, and which areas it covers.');
  }
  if (!assessment.approvedClaimsComplete) {
    priorities.push('Claims we are allowed to make in writing (guarantees, accreditations, years in business, response times) and anything we must never claim.');
  }
  if (!assessment.voiceComplete) {
    priorities.push('How they want to sound in writing — formal or casual, jargon or plain English, anything that would make them cringe.');
  }
  if (!assessment.proofComplete) {
    priorities.push('Real proof: recent jobs they are proud of, customer quotes, measurable results, awards.');
  }
  priorities.push('Anything that has changed recently — new services, new locations, price changes, staff changes, seasonal pushes.');

  const coverageSummary = existingFiles.length
    ? `They already have ${existingFiles.length} knowledge files on record covering: ${
      [...new Set(existingFiles.map((f) => f.folder))].slice(0, 12).join(', ')
    }.`
    : 'They have no knowledge files on record yet, so start from the basics.';

  return `You are the Localwave business consultant, running a short spoken interview with a client of a digital marketing agency. Your job is to collect accurate, specific facts about their business so the agency's SEO and content team can write about them correctly.

WHO YOU ARE TALKING TO
- Business: ${agencyName}
${websiteUrl ? `- Website: ${websiteUrl}\n` : ''}${industry ? `- Industry: ${industry}\n` : ''}
WHAT WE ALREADY KNOW
${coverageSummary}
${knownProfile ? `\nCurrent company profile on file:\n${knownProfile}\n` : ''}${knownVoice ? `\nCurrent brand voice on file:\n${knownVoice}\n` : ''}
Do not ask them to repeat anything above. If you want to check something we already have, confirm it briefly rather than asking from scratch.

WHAT TO FOCUS ON, IN ORDER
${priorities.map((p, i) => `${i + 1}. ${p}`).join('\n')}

HOW TO TALK
- This is a voice conversation. Keep every turn to one or two sentences.
- Ask one question at a time and then stop talking and listen.
- Speak like a person, not a form. Follow what they say rather than marching through a script.
- When an answer is vague, ask for a concrete example, a number, or a name.
- Never invent facts, never guess at numbers, and never put words in their mouth.
- If they go off-topic, let them finish, then gently steer back.
- Open by greeting them by business name and telling them this will take a few minutes and helps us write better content for them.

RECORDING WHAT YOU LEARN
- Call save_business_fact the moment you learn something concrete. Do not batch it up.
- Call flag_knowledge_gap when they cannot answer something important.
- Call finish_interview when you have covered the priorities or they want to stop, then thank them.
- Everything you record is reviewed by a human before it is used, so capture their exact meaning rather than polishing it.`;
}

/**
 * Exchanges the server API key for an ephemeral client secret bound to a
 * pre-configured session. The returned value expires within about a minute.
 */
export async function mintRealtimeSession({ instructions, tools = REALTIME_TOOLS, userId }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Voice agent is not configured. Set OPENAI_API_KEY in your .env file.');
  }

  // Bind an opaque, stable per-user identifier to the token for abuse tracking
  // without sending our internal ids to OpenAI.
  const safetyIdentifier = crypto.createHash('sha256').update(String(userId)).digest('hex');

  const res = await fetch(CLIENT_SECRETS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'OpenAI-Safety-Identifier': safetyIdentifier,
    },
    body: JSON.stringify({
      session: {
        type: 'realtime',
        model: REALTIME_MODEL,
        instructions,
        tools,
        audio: {
          // Input transcription is opt-in; without it the client's own words
          // never reach the transcript we store for the SEO team.
          input: {
            transcription: { model: process.env.OPENAI_STT_MODEL || 'whisper-1' },
            turn_detection: { type: 'semantic_vad', interrupt_response: true },
          },
          output: { voice: REALTIME_VOICE },
        },
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Realtime session request failed (${res.status}): ${detail.slice(0, 400)}`);
  }

  const data = await res.json();
  const value = data?.value || data?.client_secret?.value;
  if (!value) {
    throw new Error('Realtime session response did not include a client secret.');
  }

  return {
    clientSecret: value,
    expiresAt: data?.expires_at || data?.client_secret?.expires_at || null,
    model: REALTIME_MODEL,
    voice: REALTIME_VOICE,
  };
}
