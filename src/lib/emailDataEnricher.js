import { prisma } from './prisma.js';

/**
 * Data enrichment helpers for rich email notifications.
 *
 * Called from notificationService.js when metadata contains taskId / issueId
 * to fetch additional context for rendering task cards, comment threads, etc.
 * Failures are non-fatal — the caller falls back to simple template rendering.
 */

const APP_URL = process.env.FRONTEND_URL || 'https://app.localwaves.ai';

/**
 * Fetch rich task data for email rendering.
 *
 * @param {string} taskId
 * @returns {Promise<object|null>} Enriched task data or null on failure
 */
export async function enrichTaskData(taskId) {
  if (!taskId) return null;
  try {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        title: true,
        status: true,
        dueDate: true,
        description: true,
        priority: true,
        projectId: true,
        project: { select: { id: true, name: true } },
        assignees: { select: { id: true, name: true }, take: 5 },
      },
    });
    if (!task) return null;
    return {
      title: task.title,
      status: task.status,
      dueDate: task.dueDate ? task.dueDate.toISOString() : null,
      description: task.description || '',
      priority: task.priority,
      projectName: task.project?.name || '',
      projectColor: '#6366f1', // Default Localwaves indigo
      assignees: task.assignees.map((a) => ({ name: a.name })),
      url: `${APP_URL}/portal/pm/projects/${task.projectId}`,
    };
  } catch (err) {
    console.error(`[emailDataEnricher] enrichTaskData(${taskId}) failed:`, err.message);
    return null;
  }
}

/**
 * Fetch recent comments on a task for the comment thread section.
 *
 * @param {string} taskId
 * @param {number} [limit=3]
 * @returns {Promise<Array>} Array of { authorName, content, createdAt }
 */
export async function enrichRecentComments(taskId, limit = 3) {
  if (!taskId) return [];
  try {
    const comments = await prisma.taskComment.findMany({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        content: true,
        createdAt: true,
        user: { select: { name: true } },
      },
    });
    // Return in chronological order (oldest first)
    return comments.reverse().map((c) => ({
      authorName: c.user?.name || 'Unknown',
      content: c.content || '',
      createdAt: c.createdAt.toISOString(),
    }));
  } catch (err) {
    console.error(`[emailDataEnricher] enrichRecentComments(${taskId}) failed:`, err.message);
    return [];
  }
}

/**
 * Fetch rich issue data for email rendering.
 *
 * @param {string} issueId
 * @returns {Promise<object|null>}
 */
export async function enrichIssueData(issueId) {
  if (!issueId) return null;
  try {
    const issue = await prisma.clientIssue.findUnique({
      where: { id: issueId },
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        assignee: { select: { name: true } },
        client: { select: { agencyName: true } },
        project: { select: { name: true } },
      },
    });
    if (!issue) return null;
    return {
      title: issue.title,
      description: issue.description || '',
      status: issue.status,
      priority: issue.priority,
      assigneeName: issue.assignee?.name || null,
      clientName: issue.client?.agencyName || '',
      projectName: issue.project?.name || '',
    };
  } catch (err) {
    console.error(`[emailDataEnricher] enrichIssueData(${issueId}) failed:`, err.message);
    return null;
  }
}

/**
 * Fetch recent comments on an issue.
 *
 * @param {string} issueId
 * @param {number} [limit=3]
 * @returns {Promise<Array>}
 */
export async function enrichIssueComments(issueId, limit = 3) {
  if (!issueId) return [];
  try {
    const comments = await prisma.issueComment.findMany({
      where: { issueId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        body: true,
        createdAt: true,
        author: { select: { name: true } },
      },
    });
    return comments.reverse().map((c) => ({
      authorName: c.author?.name || 'Unknown',
      content: c.body || '',
      createdAt: c.createdAt.toISOString(),
    }));
  } catch (err) {
    console.error(`[emailDataEnricher] enrichIssueComments(${issueId}) failed:`, err.message);
    return [];
  }
}
