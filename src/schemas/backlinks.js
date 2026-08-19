import { z } from 'zod';

export const placementTypeEnum = z.enum(['GUEST_POST', 'PROFILE']);
export const targetTypeEnum = z.enum(['PAGE', 'DOMAIN']);
export const orderStatusEnum = z.enum([
  'DRAFT',
  'PENDING_REVIEW',
  'APPROVED',
  'IN_PROGRESS',
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
]);
export const orderItemStatusEnum = z.enum([
  'PENDING',
  'IN_PROGRESS',
  'LIVE',
  'REPLACED',
  'CANCELLED',
]);

export const CATALOG_SORT_FIELDS = [
  'valueScore',
  'priceUsd',
  'da',
  'dr',
  'monthlyTraffic',
  'domain',
  'createdAt',
];

const metric = z.coerce.number().int().min(0).max(100);
const optionalText = (max) => z.string().trim().max(max).optional().nullable();

export const catalogQuerySchema = z.object({
  search: z.string().trim().max(255).optional(),
  minDa: z.coerce.number().int().min(0).max(100).optional(),
  maxDa: z.coerce.number().int().min(0).max(100).optional(),
  minDr: z.coerce.number().int().min(0).max(100).optional(),
  maxDr: z.coerce.number().int().min(0).max(100).optional(),
  minTraffic: z.coerce.number().int().min(0).optional(),
  maxTraffic: z.coerce.number().int().min(0).optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  dofollowLinks: z.coerce.number().int().min(1).max(10).optional(),
  placementType: placementTypeEnum.optional(),
  category: z.string().trim().max(100).optional(),
  country: z.string().trim().max(100).optional(),
  language: z.string().trim().max(100).optional(),
  isFeatured: z.coerce.boolean().optional(),
  // Admin-only; the client catalog always forces active listings.
  isActive: z.coerce.boolean().optional(),
  sortBy: z.enum(CATALOG_SORT_FIELDS).optional().default('valueScore'),
  sortDir: z.enum(['asc', 'desc']).optional().default('desc'),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export const createSiteBodySchema = z.object({
  domain: z.string().trim().min(3).max(255),
  url: z.string().trim().max(500).optional(),
  da: metric,
  dr: metric,
  monthlyTraffic: z.coerce.number().int().min(0),
  priceUsd: z.coerce.number().positive().max(1000000),
  dofollowLinks: z.coerce.number().int().min(1).max(10).optional().default(1),
  placementType: placementTypeEnum.optional().default('GUEST_POST'),
  category: optionalText(100),
  country: optionalText(100),
  language: optionalText(100),
  turnaroundDays: z.coerce.number().int().min(0).max(365).optional().nullable(),
  sampleUrl: optionalText(500),
  isActive: z.boolean().optional().default(true),
  isFeatured: z.boolean().optional().default(false),
  tags: z.array(z.string().trim().max(50)).max(20).optional(),
  internalNotes: optionalText(5000),
});

export const updateSiteBodySchema = createSiteBodySchema.partial();

export const bulkSiteBodySchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(1000),
    action: z.enum(['activate', 'deactivate', 'feature', 'unfeature', 'delete', 'adjustPrice']),
    // Required for adjustPrice: a percentage delta (e.g. -10) or an absolute price.
    percent: z.coerce.number().min(-90).max(500).optional(),
    priceUsd: z.coerce.number().positive().max(1000000).optional(),
  })
  .refine(
    (value) => value.action !== 'adjustPrice' || value.percent != null || value.priceUsd != null,
    { message: 'adjustPrice requires either percent or priceUsd' },
  );

export const importBodySchema = z.object({
  data: z.object({ sites: z.array(z.record(z.unknown())) }).passthrough().optional(),
  filePath: z.string().trim().max(500).optional(),
  dryRun: z.boolean().optional().default(true),
  mode: z.enum(['merge', 'replace']).optional().default('merge'),
});

export const addCartItemBodySchema = z
  .object({
    backlinkSiteId: z.string().uuid(),
    projectId: z.string().uuid().optional().nullable(),
    targetType: targetTypeEnum.optional().default('DOMAIN'),
    wpPageId: z.string().uuid().optional().nullable(),
    targetUrl: z.string().trim().max(500).optional().nullable(),
    anchorText: optionalText(255),
    notes: optionalText(2000),
  })
  .refine((value) => value.targetType !== 'PAGE' || !!value.wpPageId, {
    message: 'A target page is required when targetType is PAGE',
    path: ['wpPageId'],
  })
  .refine((value) => value.targetType !== 'DOMAIN' || !!value.projectId, {
    message: 'A project is required when linking to the domain',
    path: ['projectId'],
  });

export const updateCartItemBodySchema = z
  .object({
    projectId: z.string().uuid().optional().nullable(),
    targetType: targetTypeEnum.optional(),
    wpPageId: z.string().uuid().optional().nullable(),
    targetUrl: z.string().trim().max(500).optional().nullable(),
    anchorText: optionalText(255),
    notes: optionalText(2000),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

export const checkoutBodySchema = z.object({
  clientNotes: optionalText(2000),
});

export const updateOrderBodySchema = z
  .object({
    status: orderStatusEnum.optional(),
    adminNotes: optionalText(5000),
    reason: optionalText(1000),
  })
  .refine((value) => value.status != null || value.adminNotes != null, {
    message: 'Provide a status or adminNotes',
  });

export const updateOrderItemBodySchema = z
  .object({
    status: orderItemStatusEnum.optional(),
    liveUrl: z.string().trim().max(500).optional().nullable(),
    notes: optionalText(2000),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

export const orderQuerySchema = z.object({
  status: orderStatusEnum.optional(),
  clientId: z.string().uuid().optional(),
  search: z.string().trim().max(255).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
});
