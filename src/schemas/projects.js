import { z } from 'zod';

const projectTypeEnum = z.enum([
  'SEO_CAMPAIGN',
  'AEO_GEO_CAMPAIGN',
  'WEBSITE_DESIGN',
  'WEBSITE_DEVELOPMENT',
  'SOCIAL_MEDIA_CAMPAIGN',
  'ONE_OFF_PROJECT',
]);

const projectStatusEnum = z.enum([
  'SETUP',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'ARCHIVED',
]);

export const createProjectBodySchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(1, 'Project name is required').max(255),
  projectType: projectTypeEnum,
  status: projectStatusEnum.optional().default('SETUP'),
});
