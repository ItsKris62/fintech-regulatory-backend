import { z } from 'zod';
import { AUDITED_JURISDICTIONS, JURISDICTION_CURRENCIES } from '@/config/jurisdictions.config';

export const jurisdictionCodeSchema = z.enum(AUDITED_JURISDICTIONS);
export const applicationCurrencySchema = z.enum([
  JURISDICTION_CURRENCIES.KE,
  JURISDICTION_CURRENCIES.RW,
  JURISDICTION_CURRENCIES.MW,
] as [string, string, string]);

export const applicationStatusSchema = z.enum([
  'DRAFT',
  'IN_PROGRESS',
  'SUBMITTED',
  'AWAITING_FEEDBACK',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
]);

export const documentStatusSchema = z.enum(['REQUIRED', 'UPLOADED', 'APPROVED', 'REJECTED']);
export const feeStatusSchema = z.enum(['PENDING', 'PAID', 'WAIVED']);

export const listApplicationsSchema = z.object({
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(50).default(20),
  jurisdictionCode: jurisdictionCodeSchema.optional(),
  status: applicationStatusSchema.optional(),
  search: z.string().max(100).optional(),
});

export const getApplicationSchema = z.object({
  id: z.string().min(1),
});

export const createApplicationSchema = z.object({
  title: z.string().min(3).max(200),
  jurisdictionCode: jurisdictionCodeSchema.default('KE'),
  regulator: z.string().min(2).max(120),
  licenseType: z.string().min(2).max(120),
  status: applicationStatusSchema.default('DRAFT'),
  progress: z.number().int().min(0).max(100).default(0),
  referenceNumber: z.string().max(120).optional(),
  nextAction: z.string().max(300).optional(),
  dueDate: z.date().optional(),
});

export const updateApplicationSchema = createApplicationSchema.partial().extend({
  id: z.string().min(1),
  submittedAt: z.date().nullable().optional(),
  decidedAt: z.date().nullable().optional(),
});

export const addTimelineEventSchema = z.object({
  applicationId: z.string().min(1),
  title: z.string().min(2).max(200),
  description: z.string().max(1000).optional(),
  eventDate: z.date().optional(),
  completed: z.boolean().default(false),
});

export const addApplicationDocumentSchema = z.object({
  applicationId: z.string().min(1),
  name: z.string().min(2).max(200),
  status: documentStatusSchema.default('REQUIRED'),
  vaultDocumentId: z.string().max(120).optional(),
  notes: z.string().max(1000).optional(),
  uploadedAt: z.date().nullable().optional(),
});

export const addApplicationFeeSchema = z.object({
  applicationId: z.string().min(1),
  description: z.string().min(2).max(200),
  amount: z.number().int().min(0),
  currency: applicationCurrencySchema.default('KES'),
  status: feeStatusSchema.default('PENDING'),
  paidAt: z.date().nullable().optional(),
});

export const addRegulatorFeedbackSchema = z.object({
  applicationId: z.string().min(1),
  fromName: z.string().max(120).optional(),
  message: z.string().min(2).max(2000),
  actionRequired: z.boolean().default(false),
  dueDate: z.date().nullable().optional(),
  receivedAt: z.date().optional(),
});
