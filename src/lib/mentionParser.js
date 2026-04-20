import { prisma } from './prisma.js';

/**
 * Extract @mentions from comment text and resolve them to user IDs.
 *
 * The frontend serialises mentions as `@FirstName LastName` (e.g. "@John Smith").
 * This function finds all such tokens, looks up matching active users, and returns
 * their IDs (excluding the author so they don't notify themselves).
 *
 * @param {string} text         – Raw comment body
 * @param {string} [excludeId]  – User ID to exclude (typically the comment author)
 * @returns {Promise<string[]>} – Array of unique user IDs that were mentioned
 */
export async function extractMentionedUserIds(text, excludeId = null) {
  if (!text) return [];

  // Match @FirstName LastName (supports 2-4 word names, unicode-aware)
  const mentionRegex = /@([A-Z\u00C0-\u024F][a-z\u00C0-\u024F]+(?:\s[A-Z\u00C0-\u024F][a-z\u00C0-\u024F]+){1,3})/g;
  const names = [];
  let match;
  while ((match = mentionRegex.exec(text)) !== null) {
    names.push(match[1].trim());
  }

  if (names.length === 0) return [];

  // Resolve names to user IDs (case-insensitive exact match)
  const users = await prisma.user.findMany({
    where: {
      isActive: true,
      OR: names.map((n) => ({ name: { equals: n } })),
    },
    select: { id: true },
  });

  const ids = users.map((u) => u.id).filter((id) => id !== excludeId);
  return [...new Set(ids)];
}
