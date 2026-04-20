import { z } from 'zod';

export const createMeetingBodySchema = z.object({
  clientId: z.string().uuid('Invalid client id'),
  hostId: z.string().uuid('Invalid host id'),
  title: z.string().min(1, 'Title is required').max(255),
  scheduledAt: z.string().min(1, 'scheduledAt is required'),
  status: z.string().max(50).optional(),
  meetingLink: z.union([z.string().url(), z.literal('')]).optional().nullable(),
  summary: z.string().max(5000).optional().nullable(),
});

export const updatePackageBodySchema = z.object({
  maxKeywords: z.number().int().min(0).optional(),
  keywordsLimit: z.number().int().min(0).nullable().optional(),
  projectsLimit: z.number().int().min(0).nullable().optional(),
  contentPiecesLimit: z.number().int().min(0).nullable().optional(),
  backlinksLimit: z.number().int().min(0).nullable().optional(),
  schemaPagesLimit: z.number().int().min(0).nullable().optional(),
  llmTestsLimit: z.number().int().min(0).nullable().optional(),
  storageGbLimit: z.number().min(0).nullable().optional(),
  reportHistoryMonths: z.number().int().min(0).nullable().optional(),
  teamMembersLimit: z.number().int().min(0).nullable().optional(),
  lookerReportsLimit: z.number().int().min(0).nullable().optional(),
});

export const createClientBodySchema = z.object({
  agencyName: z.string().min(1, 'Agency name is required').max(255),
  websiteUrl: z.union([z.string().url(), z.literal('')]).optional(),
  industry: z.string().max(255).optional(),
  country: z.string().max(100).optional(),
  timezone: z.string().max(100).optional(),
  packageId: z.string().uuid().optional().nullable(),
  leadPmId: z.string().uuid().optional().nullable(),
  secondaryPmId: z.string().uuid().optional().nullable(),
  contactName: z.string().min(1, 'Contact name is required').max(255),
  contactEmail: z.string().email('Valid contact email is required'),
  contactPhone: z.string().max(50).optional(),
  contactPassword: z.string().min(8, 'Password must be at least 8 characters').max(128).optional(),
});
