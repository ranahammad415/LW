/**
 * Phase 1 curated MCP tools (features/mcp-server.md §Tools). Each row maps tool arguments to an ordinary OS route
 * (checked against docs/ledger/api-routes.md and the route files) and projects the answer to a compact,
 * PII-minimised shape. Every request goes through executeOsRequest, so classification, scope, the confirm step,
 * guards and audit are the same as for os_api_request.
 *
 * Row: { name, title, description, input (zod raw shape), annotations, run(ctx, args) → outcome }
 * `project(body, args)` is also used by confirm_action to shape the result of a confirmed call.
 */
import { z } from 'zod';
import { createHash } from 'crypto';
import { canonicalJson } from '../../lib/idempotency.js';
import { executeOsRequest } from '../invoke.js';
import { AT_RISK_BELOW } from '../../routes/admin/dashboard.js';

const TASK_STATUSES = ['TO_DO', 'IN_PROGRESS', 'NEEDS_REVIEW', 'REVISION_NEEDED', 'BLOCKED', 'WAITING_DEPENDENCY', 'COMPLETED', 'CANCELLED'];
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const uuid = () => z.string().uuid();
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WR = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

function short(s, n) {
  if (typeof s !== 'string') return s ?? null;
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Idempotency-Key for a create: the same grant + tool + arguments never creates twice (7-day key life). */
export function idempotencyKeyFor(ctx, tool, args) {
  return `mcp-${createHash('sha256').update(`${ctx.grant.id}|${tool}|${canonicalJson(args)}`).digest('hex')}`;
}

function person(u) {
  return u ? { id: u.id, name: u.name ?? null } : null;
}

function taskRow(t) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority ?? null,
    dueDate: t.dueDate ?? null,
    projectId: t.projectId,
    project: t.project ? { id: t.project.id, name: t.project.name, client: t.project.client ? { id: t.project.client.id, agencyName: t.project.client.agencyName } : null } : undefined,
    assignees: Array.isArray(t.assignees) ? t.assignees.map(person) : [],
    parentTaskId: t.parentTaskId ?? null,
    subTaskCount: Array.isArray(t.subTasks) ? t.subTasks.length : undefined,
    completedAt: t.completedAt ?? null,
  };
}

function taskDetail(t) {
  return {
    ...taskRow(t),
    taskType: t.taskType ?? null,
    description: short(t.description, 4000),
    milestone: t.milestone ?? null,
    workCycleId: t.workCycleId ?? null,
    updatedAt: t.updatedAt ?? null,
    dependsOn: Array.isArray(t.dependsOnTasks) ? t.dependsOnTasks.map((d) => ({ id: d.id, status: d.status, title: d.title ?? undefined })) : [],
    deliverableCount: Array.isArray(t.deliverables) ? t.deliverables.length : 0,
    subTasks: Array.isArray(t.subTasks) ? t.subTasks.map((s) => ({ id: s.id, title: s.title, status: s.status, assignees: (s.assignees || []).map(person) })) : [],
  };
}

function findTaskInTree(tasks, id) {
  for (const t of tasks || []) {
    if (t.id === id) return t;
    const sub = findTaskInTree(t.subTasks, id);
    if (sub) return sub;
  }
  return null;
}

function countByStatus(tasks) {
  const out = {};
  for (const t of tasks || []) out[t.status] = (out[t.status] || 0) + 1;
  return out;
}

const ok = (payload, outcome) => ({ ...outcome, kind: 'result', payload });

/** Runs one request and, on success, shapes it with `project`. */
async function call(ctx, toolName, req, project, args) {
  const out = await executeOsRequest(ctx, { ...req, toolName }, { toolArgs: args });
  if (out.kind !== 'result') return out;
  return ok(project(out.body, args), out);
}

export const PROJECTIONS = {
  os_whoami: (body, _args, ctx) => ({
    user: { id: body?.id, name: body?.name, email: body?.email, role: body?.role },
    connection: ctx ? { app: ctx.client?.clientName ?? null, scope: ctx.scope, grantId: ctx.grant.id } : undefined,
  }),
  os_overview: (body) => {
    const map = Array.isArray(body?.clientHealthMap) ? body.clientHealthMap : [];
    const scored = map.filter((c) => c.healthScore != null).sort((a, b) => a.healthScore - b.healthScore);
    return {
      metrics: body?.metrics ?? null,
      atRiskClients: scored.filter((c) => c.healthScore < AT_RISK_BELOW).slice(0, 20).map((c) => ({ id: c.id, agencyName: c.agencyName, healthScore: c.healthScore, band: c.band ?? null, trend28: c.trend28 ?? null })),
      clientHealthMap: scored.slice(0, 20).map((c) => ({ id: c.id, agencyName: c.agencyName, healthScore: c.healthScore, band: c.band ?? null, trend28: c.trend28 ?? null, coverage: c.coverage ?? null })),
      clientsWithoutScore: map.length - scored.length,
      openIssues: (body?.openIssues || []).slice(0, 10).map((i) => ({ id: i.id, title: i.title, status: i.status, priority: i.priority, client: i.client?.agencyName ?? null })),
    };
  },
  os_clients_list: (body, args = {}) => {
    let rows = Array.isArray(body) ? body : [];
    if (args.search) {
      const s = String(args.search).toLowerCase();
      rows = rows.filter((c) => String(c.agencyName || '').toLowerCase().includes(s) || String(c.websiteUrl || '').toLowerCase().includes(s));
    }
    if (args.status) rows = rows.filter((c) => (args.status === 'active' ? c.isActive !== false : c.isActive === false));
    const limit = Math.min(100, args.limit || 50);
    return {
      total: rows.length,
      truncated: rows.length > limit || undefined,
      clients: rows.slice(0, limit).map((c) => ({
        id: c.id,
        agencyName: c.agencyName,
        status: c.isActive === false ? 'inactive' : 'active',
        websiteUrl: c.websiteUrl ?? null,
        industry: c.industry ?? null,
        leadPmId: c.leadPmId ?? null,
        secondaryPmId: c.secondaryPmId ?? null,
        healthScore: c.healthScore ?? null,
        healthTrend28: c.healthTrend28 ?? null,
        package: c.package?.name ?? null,
        onboardingStatus: c.onboardingStatus ?? null,
        clientUserCount: Array.isArray(c.clientUsers) ? c.clientUsers.length : 0,
      })),
    };
  },
  os_client_get: (body, args = {}) => {
    if (!body || typeof body !== 'object') return body;
    const { internalNotes, clientUsers, analyticsEmails, analyticsGoogleEmail, ...rest } = body;
    const out = { ...rest };
    if (args.includeNotes && internalNotes !== undefined) out.internalNotes = internalNotes;
    out.clientUsers = (clientUsers || []).map((cu) => {
      const u = cu.user || {};
      const base = { userId: u.id ?? cu.userId, name: u.name ?? null, role: cu.role ?? null, isPrimaryContact: cu.isPrimaryContact ?? undefined };
      return args.includeContacts ? { ...base, email: u.email ?? null, phone: u.phone ?? null } : base;
    });
    if (args.includeContacts) {
      out.analyticsGoogleEmail = analyticsGoogleEmail ?? null;
      out.analyticsEmails = analyticsEmails ?? [];
    }
    return out;
  },
  os_projects_list: (body, args = {}) => {
    let rows = Array.isArray(body) ? body : [];
    if (args.clientId) rows = rows.filter((p) => p.clientId === args.clientId || p.client?.id === args.clientId);
    if (args.status) rows = rows.filter((p) => String(p.status || '').toUpperCase() === String(args.status).toUpperCase());
    const limit = Math.min(200, args.limit || 100);
    return {
      total: rows.length,
      truncated: rows.length > limit || undefined,
      projects: rows.slice(0, limit).map((p) => ({
        id: p.id,
        name: p.name,
        projectType: p.projectType ?? null,
        status: p.status ?? null,
        cmsType: p.cmsType ?? null,
        client: p.client ? { id: p.client.id, agencyName: p.client.agencyName } : null,
        leadPm: person(p.leadPm),
        updatedAt: p.updatedAt ?? null,
      })),
    };
  },
  os_project_get: (body, args = {}) => {
    if (!body || typeof body !== 'object') return body;
    const tasks = Array.isArray(body.tasks) ? body.tasks : [];
    const out = {
      id: body.id,
      name: body.name,
      projectType: body.projectType ?? null,
      status: body.status ?? null,
      cmsType: body.cmsType ?? null,
      wpUrl: body.wpUrl ?? null,
      client: body.client ? { id: body.client.id, agencyName: body.client.agencyName } : null,
      leadPm: person(body.leadPm),
      taskCount: tasks.length,
      tasksByStatus: countByStatus(tasks),
      keywordSuggestionCount: Array.isArray(body.keywordSuggestions) ? body.keywordSuggestions.length : 0,
      clientAssetCount: Array.isArray(body.clientAssets) ? body.clientAssets.length : 0,
    };
    if (args.includeTasks) out.tasks = tasks.slice(0, 200).map(taskRow);
    return out;
  },
  os_tasks_list: (body, args = {}) => {
    let rows = Array.isArray(body) ? body : [];
    if (args.projectId) rows = rows.filter((t) => t.projectId === args.projectId);
    const limit = Math.min(200, args.limit || 50);
    return { total: rows.length, truncated: rows.length > limit || undefined, tasks: rows.slice(0, limit).map(taskRow) };
  },
  os_task_create: (body) => (body && typeof body === 'object' ? { created: taskRow(body) } : body),
  os_task_update: (body) => (body && typeof body === 'object' ? { updated: { id: body.id, title: body.title ?? undefined, status: body.status ?? undefined, priority: body.priority ?? undefined, dueDate: body.dueDate ?? undefined, assignees: Array.isArray(body.assignees) ? body.assignees.map(person) : undefined } } : body),
  os_task_status: (body) => (body && typeof body === 'object' ? { id: body.id, status: body.status, completedAt: body.completedAt ?? null, updatedAt: body.updatedAt ?? null } : body),
  os_task_comment: (body) => (body && typeof body === 'object' ? { comment: { id: body.id, taskId: body.taskId, createdAt: body.createdAt, parentId: body.parentId ?? null } } : body),
};

function cycleQuery(cycle) {
  if (!cycle) return {};
  if (cycle === 'all') return { cycle: 'all' };
  const [year, month] = cycle.split('-');
  return { month: String(Number(month)), year };
}

export const CURATED_TOOLS = [
  {
    name: 'os_whoami',
    title: 'Who am I',
    description: 'The signed-in OS user (name, email, role) and this connection\'s scope. Call first.',
    input: {},
    annotations: { title: 'Who am I', ...RO },
    run: async (ctx, args) => {
      const out = await executeOsRequest(ctx, { method: 'GET', path: '/api/users/me', toolName: 'os_whoami' }, { toolArgs: args });
      return out.kind === 'result' ? ok(PROJECTIONS.os_whoami(out.body, args, ctx), out) : out;
    },
  },
  {
    name: 'os_overview',
    title: 'Agency overview',
    description: 'Agency dashboard: active clients, tasks due today, deliverables pending, on-time rate, at-risk clients (lowest health first, top 20) and open issues.',
    input: {},
    annotations: { title: 'Agency overview', ...RO },
    run: (ctx, args) => call(ctx, 'os_overview', { method: 'GET', path: '/api/admin/dashboard' }, PROJECTIONS.os_overview, args),
  },
  {
    name: 'os_clients_list',
    title: 'List clients',
    description: 'Client accounts: id, name, status, lead PM ids, health score, plan. No contact details. Filter by name/website text and status.',
    input: {
      search: z.string().max(100).optional().describe('Text to match in the client name or website'),
      status: z.enum(['active', 'inactive']).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { title: 'List clients', ...RO },
    run: (ctx, args) => call(ctx, 'os_clients_list', { method: 'GET', path: '/api/admin/clients' }, PROJECTIONS.os_clients_list, args),
  },
  {
    name: 'os_client_get',
    title: 'Get client',
    description: 'One client account with its projects and plan. Client users\' email/phone only with includeContacts; internal notes only with includeNotes.',
    input: {
      clientId: z.string().min(1).max(191),
      includeContacts: z.boolean().optional(),
      includeNotes: z.boolean().optional(),
    },
    annotations: { title: 'Get client', ...RO },
    run: (ctx, args) => call(ctx, 'os_client_get', { method: 'GET', path: `/api/admin/clients/${encodeURIComponent(args.clientId)}` }, PROJECTIONS.os_client_get, args),
  },
  {
    name: 'os_projects_list',
    title: 'List projects',
    description: 'Projects you can see (OWNER: all): id, name, type, status, CMS, client, lead PM. Filter by clientId or status.',
    input: {
      clientId: z.string().min(1).max(191).optional(),
      status: z.string().max(40).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    annotations: { title: 'List projects', ...RO },
    run: (ctx, args) => call(ctx, 'os_projects_list', { method: 'GET', path: '/api/projects' }, PROJECTIONS.os_projects_list, args),
  },
  {
    name: 'os_project_get',
    title: 'Get project',
    description: 'One project: client, lead PM, task counts by status. includeTasks adds a pruned task list (id/title/status/assignees/due). cycle: "all" or "YYYY-MM" (default current month).',
    input: {
      projectId: uuid(),
      includeTasks: z.boolean().optional(),
      cycle: z.string().regex(/^(all|\d{4}-\d{2})$/).optional(),
    },
    annotations: { title: 'Get project', ...RO },
    run: (ctx, args) => call(ctx, 'os_project_get', { method: 'GET', path: `/api/projects/${args.projectId}`, query: cycleQuery(args.cycle) }, PROJECTIONS.os_project_get, args),
  },
  {
    name: 'os_tasks_list',
    title: 'List tasks',
    description: 'Tasks you can see, current month unless cycle is "all" or "YYYY-MM". Filters: projectId, status list, assignee "me". Compact rows.',
    input: {
      projectId: uuid().optional(),
      status: z.array(z.enum(TASK_STATUSES)).max(8).optional(),
      assignee: z.literal('me').optional(),
      cycle: z.string().regex(/^(all|\d{4}-\d{2})$/).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    annotations: { title: 'List tasks', ...RO },
    run: (ctx, args) => {
      const query = { ...cycleQuery(args.cycle) };
      if (args.status?.length) query.status = args.status.join(',');
      if (args.assignee) query.assignee = args.assignee;
      return call(ctx, 'os_tasks_list', { method: 'GET', path: '/api/tasks', query }, PROJECTIONS.os_tasks_list, args);
    },
  },
  {
    name: 'os_task_get',
    title: 'Get task',
    description: 'One task with description, assignees, sub-tasks, dependencies and its latest comments.',
    input: { taskId: uuid() },
    annotations: { title: 'Get task', ...RO },
    // There is no GET /api/tasks/:id. The comments route runs the task access guard first; only then is the task's
    // projectId read (one Prisma read, no write) and the task taken from the guarded GET /api/projects/:id?cycle=all.
    run: async (ctx, args) => {
      const comments = await executeOsRequest(ctx, { method: 'GET', path: `/api/tasks/${args.taskId}/comments`, toolName: 'os_task_get' }, { toolArgs: args });
      if (comments.kind !== 'result') return comments;
      const row = await ctx.db.task.findUnique({ where: { id: args.taskId }, select: { projectId: true } });
      if (!row) return { kind: 'error', code: 'HTTP_404', statusCode: 404, message: 'Task not found', danger: 'read', route: comments.route };
      const project = await executeOsRequest(ctx, { method: 'GET', path: `/api/projects/${row.projectId}`, query: { cycle: 'all' }, toolName: 'os_task_get' }, { toolArgs: args });
      if (project.kind !== 'result') return project;
      const task = findTaskInTree(project.body?.tasks, args.taskId);
      if (!task) return { kind: 'error', code: 'HTTP_404', statusCode: 404, message: 'Task not found in its project', danger: 'read', route: project.route };
      const list = Array.isArray(comments.body) ? comments.body : Array.isArray(comments.body?.comments) ? comments.body.comments : [];
      return ok(
        {
          task: { ...taskDetail(task), project: { id: project.body.id, name: project.body.name, client: project.body.client ? { id: project.body.client.id, agencyName: project.body.client.agencyName } : null } },
          commentCount: list.length,
          comments: list.slice(-20).map((c) => ({ id: c.id, author: c.user?.name ?? null, content: short(c.content, 1000), createdAt: c.createdAt, parentId: c.parentId ?? null })),
        },
        project
      );
    },
  },
  {
    name: 'os_task_create',
    title: 'Create task',
    description: 'Create a task in a project (OWNER/PM). Retrying the same call never creates a duplicate. taskType defaults to "general".',
    input: {
      projectId: uuid(),
      title: z.string().min(1).max(500),
      description: z.string().max(10_000).optional(),
      taskType: z.string().min(1).max(100).optional(),
      priority: z.enum(PRIORITIES).optional(),
      dueDate: z.string().max(40).optional().describe('ISO date, e.g. 2026-11-15'),
      assigneeIds: z.array(uuid()).max(20).optional(),
      parentTaskId: uuid().optional(),
    },
    annotations: { title: 'Create task', ...WR },
    run: (ctx, args) => {
      const body = { projectId: args.projectId, title: args.title, taskType: args.taskType || 'general' };
      for (const k of ['description', 'priority', 'dueDate', 'assigneeIds', 'parentTaskId']) if (args[k] !== undefined) body[k] = args[k];
      return call(ctx, 'os_task_create', { method: 'POST', path: '/api/tasks', body, idempotencyKey: idempotencyKeyFor(ctx, 'os_task_create', body) }, PROJECTIONS.os_task_create, args);
    },
  },
  {
    name: 'os_task_update',
    title: 'Update task',
    description: 'Edit a task\'s title, description, priority, due date or assignees (replaces the assignee list). Status changes use os_task_status.',
    input: {
      taskId: uuid(),
      title: z.string().min(1).max(500).optional(),
      description: z.string().max(10_000).nullable().optional(),
      priority: z.enum(PRIORITIES).optional(),
      dueDate: z.string().max(40).nullable().optional(),
      assigneeIds: z.array(uuid()).max(20).optional(),
    },
    annotations: { title: 'Update task', ...WR, idempotentHint: true },
    run: (ctx, args) => {
      const { taskId, ...fields } = args;
      const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (!Object.keys(body).length) return { kind: 'error', code: 'INVALID_REQUEST', message: 'Nothing to update', danger: 'write' };
      return call(ctx, 'os_task_update', { method: 'PATCH', path: `/api/tasks/${taskId}`, body }, PROJECTIONS.os_task_update, args);
    },
  },
  {
    name: 'os_task_status',
    title: 'Change task status',
    description: 'Move a task to a new status. COMPLETED and CANCELLED are dangerous: the first call returns a preview and confirm_token; call confirm_action after the user agrees.',
    input: { taskId: uuid(), status: z.enum(TASK_STATUSES) },
    annotations: { title: 'Change task status', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (ctx, args) => {
      const body = { status: args.status };
      // No Idempotency-Key: setting a status is idempotent by itself, and a key over the args would replay an old
      // answer when the same status is set again later (TO_DO → IN_PROGRESS → TO_DO → IN_PROGRESS).
      return call(ctx, 'os_task_status', { method: 'PATCH', path: `/api/tasks/${args.taskId}/status`, body }, PROJECTIONS.os_task_status, args);
    },
  },
  {
    name: 'os_task_comment',
    title: 'Comment on task',
    description: 'Add a comment to a task as the signed-in user (@mentions notify as in the UI). Retrying the same call never posts twice.',
    input: { taskId: uuid(), content: z.string().min(1).max(10_000), parentId: uuid().optional() },
    annotations: { title: 'Comment on task', ...WR },
    run: (ctx, args) => {
      const body = { content: args.content };
      if (args.parentId) body.parentId = args.parentId;
      return call(ctx, 'os_task_comment', { method: 'POST', path: `/api/tasks/${args.taskId}/comments`, body, idempotencyKey: idempotencyKeyFor(ctx, 'os_task_comment', args) }, PROJECTIONS.os_task_comment, args);
    },
  },
];
