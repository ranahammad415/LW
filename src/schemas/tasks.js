import { z } from 'zod';

const taskStatusEnum = z.enum([
  'TO_DO',
  'IN_PROGRESS',
  'NEEDS_REVIEW',
  'REVISION_NEEDED',
  'BLOCKED',
  'WAITING_DEPENDENCY',
  'COMPLETED',
  'CANCELLED',
]);

const taskPriorityEnum = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

export const createTaskBodySchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1, 'Title is required').max(500),
  description: z.string().max(10000).optional(),
  taskType: z.string().min(1, 'Task type is required').max(100),
  priority: taskPriorityEnum.optional().default('MEDIUM'),
  dueDate: z.coerce.date().optional().nullable(),
  assignedTo: z.string().uuid().optional().nullable(),
  assigneeIds: z.array(z.string().uuid()).optional().default([]),
  dependencyIds: z.array(z.string().uuid()).optional().default([]),
  parentTaskId: z.string().uuid().optional().nullable(),
  milestone: z.string().max(100).optional().nullable(),
});

export const updateTaskStatusBodySchema = z.object({
  status: taskStatusEnum,
});
