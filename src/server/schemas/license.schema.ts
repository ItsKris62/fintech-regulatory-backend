import { z } from 'zod';

export const LICENSE_STATUSES = [
  'DRAFT',
  'ACTIVE',
  'PENDING_RENEWAL',
  'SUBMITTED',
  'APPROVED',
  'EXPIRED',
  'SUSPENDED',
  'REVOKED',
  'ARCHIVED',
] as const;

export const LICENSE_TIMELINE_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED'] as const;
export const LICENSE_FEE_STATUSES = ['PENDING', 'PAID', 'WAIVED', 'OVERDUE'] as const;

const optionalIsoDate = z.string().datetime().optional().nullable();

export const listLicensesSchema = z.object({
  status: z.enum(LICENSE_STATUSES).optional(),
  search: z.string().trim().max(120).optional(),
  includeArchived: z.boolean().optional().default(false),
  page: z.number().int().min(1).optional().default(1),
  limit: z.number().int().min(1).max(100).optional().default(25),
});

export const getLicenseSchema = z.object({
  id: z.string().cuid(),
});

export const createLicenseSchema = z.object({
  licenseType: z.string().trim().min(1).max(160),
  regulator: z.string().trim().min(1).max(160),
  licenseNumber: z.string().trim().max(120).optional(),
  status: z.enum(LICENSE_STATUSES).optional().default('ACTIVE'),
  issueDate: optionalIsoDate,
  expiryDate: optionalIsoDate,
  renewalDueDate: optionalIsoDate,
  submittedAt: optionalIsoDate,
  approvedAt: optionalIsoDate,
  assignedOwnerId: z.string().cuid().optional().nullable(),
  notes: z.string().max(5000).optional(),
});

export const updateLicenseSchema = createLicenseSchema.partial().extend({
  id: z.string().cuid(),
});

export const archiveLicenseSchema = z.object({
  id: z.string().cuid(),
});

export const addTimelineEventSchema = z.object({
  licenseId: z.string().cuid(),
  eventType: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(3000).optional(),
  dueDate: optionalIsoDate,
  status: z.enum(LICENSE_TIMELINE_STATUSES).optional().default('PENDING'),
  assignedToUserId: z.string().cuid().optional().nullable(),
  evidenceDocumentId: z.string().cuid().optional().nullable(),
  createCalendarEvent: z.boolean().optional().default(true),
});

export const updateTimelineEventSchema = addTimelineEventSchema.partial().extend({
  id: z.string().cuid(),
});

export const completeTimelineEventSchema = z.object({
  id: z.string().cuid(),
});

export const addDocumentSchema = z.object({
  licenseId: z.string().cuid(),
  vaultDocumentId: z.string().cuid(),
  documentType: z.string().trim().max(120).optional(),
  notes: z.string().max(2000).optional(),
});

export const removeDocumentSchema = z.object({
  id: z.string().cuid(),
});

export const addFeeSchema = z.object({
  licenseId: z.string().cuid(),
  amount: z.number().nonnegative().optional().nullable(),
  currency: z.string().trim().length(3).optional().default('KES'),
  description: z.string().trim().max(240).optional(),
  dueDate: optionalIsoDate,
  paidAt: optionalIsoDate,
  status: z.enum(LICENSE_FEE_STATUSES).optional().default('PENDING'),
});

export const updateFeeSchema = addFeeSchema.partial().extend({
  id: z.string().cuid(),
});

export const upcomingLicensesSchema = z.object({
  daysAhead: z.number().int().min(1).max(730).optional().default(90),
});

export const adminListLicensesSchema = listLicensesSchema.extend({
  organizationId: z.string().cuid().optional(),
});

export const adminGetLicenseSchema = z.object({
  id: z.string().cuid(),
  reason: z.string().trim().min(10).max(1000).optional(),
});

export const adminOverrideUpdateLicenseSchema = updateLicenseSchema.extend({
  reason: z.string().trim().min(10).max(1000),
});
