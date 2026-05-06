import { generateChat, isAiConfigured, sanitizeUserInputForPrompt } from '../../lib/ai.js';
import { aiRateLimit } from '../../lib/aiRateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { transcribeAudio, synthesizeSpeech, isVoiceConfigured } from '../../lib/voice.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { resolveUploadBaseUrl, MAX_UPLOAD_SIZE_BYTES } from '../../lib/uploadUrl.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const UPLOADS_ROOT = join(__dirname, '..', '..', '..', 'uploads');

// --- Helpers ----------------------------------------------------------------

function buildNovaSystemPrompt(agencyName, activeTasksCount, conversationSummary) {
  const summaryBlock = conversationSummary
    ? `\n\nSummary of the earlier part of this conversation (for your reference):\n${conversationSummary}\n`
    : '';
  return `You are Localwave Assistant, the intelligent agency assistant. You are friendly, concise, and professional.

Context about the client you are talking to:
- Company/agency name: ${agencyName ?? 'Unknown'}
- Number of active tasks currently being worked on: ${activeTasksCount}

Use this context to personalise answers when relevant (e.g. "With ${activeTasksCount} active tasks right now…"). Keep responses helpful and to the point. Do not make up data; if you don't know something, say so.${summaryBlock}`;
}

async function getPrimaryClientAndActiveTasksCount(clientIds, primaryClientId) {
  if (!clientIds || clientIds.length === 0) return null;
  const targetClientId = primaryClientId && clientIds.includes(primaryClientId)
    ? primaryClientId
    : clientIds[0];
  const primaryClient = await prisma.clientAccount.findUnique({
    where: { id: targetClientId },
    select: { id: true, agencyName: true },
  });
  if (!primaryClient) return null;
  const activeTasksCount = await prisma.task.count({
    where: {
      project: { clientId: { in: clientIds } },
      clientVisible: true,
      status: { notIn: ['COMPLETED', 'CANCELLED'] },
    },
  });
  return {
    clientId: primaryClient.id,
    agencyName: primaryClient.agencyName,
    activeTasksCount,
  };
}

const RECENT_RAW_MESSAGES = 10;
const SUMMARIZE_THRESHOLD = 20; // roll older messages into summary above this count

function deriveTitleFromText(text) {
  if (!text) return 'New conversation';
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= 60) return clean || 'New conversation';
  return clean.slice(0, 57) + '…';
}

/**
 * Fire-and-forget summarization of older messages. Runs in background so chat
 * latency is unaffected. Errors are logged but never surfaced.
 */
async function maybeSummarizeOlderMessages(conversationId, logger) {
  try {
    const total = await prisma.novaMessage.count({ where: { conversationId } });
    if (total < SUMMARIZE_THRESHOLD) return;

    const older = await prisma.novaMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      take: total - RECENT_RAW_MESSAGES,
      select: { role: true, content: true },
    });
    if (older.length === 0) return;

    const existing = await prisma.novaConversation.findUnique({
      where: { id: conversationId },
      select: { summary: true },
    });

    const transcript = older.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
    const system = `You maintain a rolling summary of a chat between a client and Localwave Assistant. Merge the prior summary (if any) with the new transcript into a concise, factual summary (max 500 words) capturing: user's goals, key questions answered, open threads, and any preferences shared. Return plain text only — no markdown.`;
    const user = `Prior summary:\n${existing?.summary || '(none)'}\n\nNew transcript to fold in:\n${transcript}`;

    const { text } = await generateChat({
      system,
      user,
      maxTokens: 800,
      feature: 'nova_summarize',
    });
    if (text && text.trim()) {
      await prisma.novaConversation.update({
        where: { id: conversationId },
        data: { summary: text.trim().slice(0, 10000) },
      });
    }
  } catch (err) {
    logger?.warn?.({ err }, 'Nova summarization failed (non-fatal)');
  }
}

// --- Routes -----------------------------------------------------------------

export async function clientNovaRoutes(app) {
  // GET /nova/conversations — list this user's conversations
  app.get(
    '/nova/conversations',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      const conversations = await prisma.novaConversation.findMany({
        where: { userId: request.user.id },
        orderBy: { lastMessageAt: 'desc' },
        take: 100,
        select: {
          id: true,
          title: true,
          lastMessageAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return reply.send({ conversations });
    }
  );

  // POST /nova/conversations — create a new empty conversation
  app.post(
    '/nova/conversations',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      const clientIds = request.clientAccountIds || [];
      const primaryLink = (request.clientUserRoles || []).find((cu) => cu.isPrimaryContact);
      const clientId = primaryLink?.clientId || clientIds[0] || null;

      const conversation = await prisma.novaConversation.create({
        data: {
          userId: request.user.id,
          clientId,
        },
        select: { id: true, title: true, lastMessageAt: true, createdAt: true },
      });
      return reply.status(201).send({ conversation });
    }
  );

  // GET /nova/conversations/:id/messages — paginated history
  app.get(
    '/nova/conversations/:id/messages',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      const { id } = request.params;
      const conversation = await prisma.novaConversation.findUnique({
        where: { id },
        select: { id: true, userId: true, title: true, summary: true, lastMessageAt: true },
      });
      if (!conversation || conversation.userId !== request.user.id) {
        return reply.status(404).send({ message: 'Conversation not found' });
      }
      const limit = Math.min(Number(request.query?.limit) || 200, 500);
      const messages = await prisma.novaMessage.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: 'asc' },
        take: limit,
        select: {
          id: true,
          role: true,
          content: true,
          audioUrl: true,
          createdAt: true,
        },
      });
      return reply.send({ conversation, messages });
    }
  );

  // DELETE /nova/conversations/:id
  app.delete(
    '/nova/conversations/:id',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      const { id } = request.params;
      const conversation = await prisma.novaConversation.findUnique({
        where: { id },
        select: { id: true, userId: true },
      });
      if (!conversation || conversation.userId !== request.user.id) {
        return reply.status(404).send({ message: 'Conversation not found' });
      }
      await prisma.novaConversation.delete({ where: { id } });
      return reply.send({ deleted: true });
    }
  );

  // POST /nova/chat — send a message (persists history when conversationId given)
  app.post(
    '/nova/chat',
    {
      onRequest: [app.verifyJwt, app.requireClient, aiRateLimit('nova_chat')],
      schema: {
        body: {
          type: 'object',
          properties: {
            message: { type: 'string' },
            conversationId: { type: 'string' },
            audioUrl: { type: 'string' },
            // legacy client-side history (used when no conversationId)
            history: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string', enum: ['user', 'assistant'] },
                  content: { type: 'string' },
                },
              },
            },
          },
          required: ['message'],
        },
      },
    },
    async (request, reply) => {
      if (!isAiConfigured()) {
        return reply.status(503).send({
          message: 'Localwave Assistant is not configured. Set ANTHROPIC_API_KEY in your .env file.',
        });
      }

      const { message, conversationId, audioUrl, history = [] } = request.body || {};
      const rawMessage = typeof message === 'string' ? message.trim() : '';
      if (!rawMessage) {
        return reply.status(400).send({ message: 'message is required' });
      }
      const trimmedMessage = sanitizeUserInputForPrompt(rawMessage);

      const clientIds = request.clientAccountIds || [];
      const primaryLink = (request.clientUserRoles || []).find((cu) => cu.isPrimaryContact);
      const context = await getPrimaryClientAndActiveTasksCount(clientIds, primaryLink?.clientId);
      if (!context) {
        return reply.status(404).send({ message: 'No client account linked' });
      }

      // Resolve conversation (optional). Load history + summary when present.
      let conversation = null;
      let persistedHistory = [];
      let summary = null;
      if (conversationId) {
        conversation = await prisma.novaConversation.findUnique({
          where: { id: conversationId },
          select: { id: true, userId: true, title: true, summary: true },
        });
        if (!conversation || conversation.userId !== request.user.id) {
          return reply.status(404).send({ message: 'Conversation not found' });
        }
        summary = conversation.summary;
        const recent = await prisma.novaMessage.findMany({
          where: { conversationId },
          orderBy: { createdAt: 'desc' },
          take: RECENT_RAW_MESSAGES * 2, // both roles
          select: { role: true, content: true },
        });
        persistedHistory = recent.reverse();
      }

      const systemPrompt = buildNovaSystemPrompt(context.agencyName, context.activeTasksCount, summary);

      const historyForPrompt = persistedHistory.length
        ? persistedHistory
        : history
            .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
            .slice(-RECENT_RAW_MESSAGES * 2)
            .map((m) => ({ role: m.role, content: m.content }));

      const messages = [
        { role: 'system', content: systemPrompt },
        ...historyForPrompt.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: trimmedMessage },
      ];

      try {
        const { text, tokensIn, tokensOut } = await generateChat({
          messages,
          maxTokens: 1024,
          feature: 'nova_chat',
          userId: request.user.id,
          clientId: context.clientId,
        });
        const response = typeof text === 'string' && text
          ? text
          : 'Sorry, I couldn’t generate a response. Please try again.';

        // Persist when we have a conversation
        if (conversation) {
          const now = new Date();
          const isFirstTurn = persistedHistory.length === 0;

          await prisma.$transaction([
            prisma.novaMessage.create({
              data: {
                conversationId: conversation.id,
                role: 'user',
                content: rawMessage.slice(0, 20000),
                audioUrl: audioUrl || null,
                tokensIn: null,
                tokensOut: null,
              },
            }),
            prisma.novaMessage.create({
              data: {
                conversationId: conversation.id,
                role: 'assistant',
                content: response.slice(0, 20000),
                model: process.env.AI_MODEL || null,
                tokensIn: tokensIn || 0,
                tokensOut: tokensOut || 0,
              },
            }),
            prisma.novaConversation.update({
              where: { id: conversation.id },
              data: {
                lastMessageAt: now,
                ...(isFirstTurn && { title: deriveTitleFromText(rawMessage) }),
              },
            }),
          ]);

          // Fire-and-forget rolling summary — don't await
          maybeSummarizeOlderMessages(conversation.id, request.log).catch(() => {});
        }

        return reply.send({
          response,
          conversationId: conversation?.id || null,
        });
      } catch (err) {
        request.log.error({ err }, 'Localwave AI request failed');
        return reply.status(502).send({
          message: err.message || 'Localwave Assistant is temporarily unavailable. Please try again.',
        });
      }
    }
  );

  // POST /nova/voice/transcribe — multipart audio → text
  app.post(
    '/nova/voice/transcribe',
    { onRequest: [app.verifyJwt, app.requireClient, aiRateLimit('nova_voice_transcribe')] },
    async (request, reply) => {
      if (!isVoiceConfigured()) {
        return reply.status(503).send({
          message: 'Voice is not configured. Set OPENAI_API_KEY in your .env file.',
        });
      }
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ message: 'No audio file uploaded' });
      }
      const originalName = data.filename || 'voice.webm';
      const safeExt = (originalName.match(/\.(webm|m4a|mp3|mp4|wav|ogg)$/i)?.[0] || '.webm').toLowerCase();
      const buffer = await data.toBuffer();
      if (buffer.length > MAX_UPLOAD_SIZE_BYTES) {
        return reply.status(413).send({ message: 'Audio file too large' });
      }
      // Strict audio-only validation for the voice pipeline.
      const mt = String(data.mimetype || '').toLowerCase();
      if (mt && !mt.startsWith('audio/') && mt !== 'video/webm' && mt !== 'video/mp4') {
        return reply.status(400).send({ message: `Unsupported audio type: ${mt}` });
      }

      // Optionally persist the user's audio so it can be replayed later.
      let audioUrl = null;
      try {
        const now = new Date();
        const year = String(now.getFullYear());
        const monthDay = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const dir = join(UPLOADS_ROOT, year, monthDay);
        mkdirSync(dir, { recursive: true });
        const storedName = `nova-${randomUUID()}${safeExt}`;
        writeFileSync(join(dir, storedName), buffer);
        const baseUrl = resolveUploadBaseUrl(request);
        const relPath = `/uploads/${year}/${monthDay}/${storedName}`;
        audioUrl = baseUrl ? `${baseUrl}${relPath}` : relPath;
      } catch (err) {
        request.log.warn({ err }, 'Nova voice: failed to persist audio (non-fatal)');
      }

      try {
        const { text } = await transcribeAudio(buffer, `voice${safeExt}`);
        return reply.send({ text: text || '', audioUrl });
      } catch (err) {
        request.log.error({ err }, 'Nova voice transcribe failed');
        return reply.status(502).send({
          message: err.message || 'Transcription failed',
        });
      }
    }
  );

  // POST /nova/voice/speak — text → audio/mpeg stream
  app.post(
    '/nova/voice/speak',
    {
      onRequest: [app.verifyJwt, app.requireClient, aiRateLimit('nova_voice_speak')],
      schema: {
        body: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            voice: { type: 'string' },
          },
          required: ['text'],
        },
      },
    },
    async (request, reply) => {
      if (!isVoiceConfigured()) {
        return reply.status(503).send({
          message: 'Voice is not configured. Set OPENAI_API_KEY in your .env file.',
        });
      }
      const { text, voice } = request.body || {};
      const input = typeof text === 'string' ? text.trim() : '';
      if (!input) return reply.status(400).send({ message: 'text is required' });
      try {
        const { audioBuffer, contentType } = await synthesizeSpeech(input, voice);
        reply
          .header('Content-Type', contentType)
          .header('Cache-Control', 'no-store');
        return reply.send(audioBuffer);
      } catch (err) {
        request.log.error({ err }, 'Nova voice speak failed');
        return reply.status(502).send({
          message: err.message || 'Speech synthesis failed',
        });
      }
    }
  );
}
