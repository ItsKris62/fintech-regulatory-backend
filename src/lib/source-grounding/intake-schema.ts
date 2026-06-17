import { z } from 'zod';

export const ReviewStatusSchema = z.enum([
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'NEEDS_MANUAL_REVIEW',
]);

export const PrioritySourceMetadataIntakeSchema = z.object({
  regulatoryDocumentId: z.string().min(1),
  currentTitle: z.string().min(1),
  normalizedTitle: z.string().min(1),
  approvedSourceId: z.string().min(1).nullable(),
  authorityName: z.string().min(1),
  officialUrl: z.string().url().nullable(),
  publicationDate: z.string().datetime().nullable(),
  retrievedAt: z.string().datetime().nullable(),
  effectiveDate: z.string().datetime().nullable(),
  effectiveEndDate: z.string().datetime().nullable(),
  versionLabel: z.string().nullable(),
  checksumSha256: z.string().nullable(),
  status: z.string(),
  authorityStatus: z.string(),
  isBinding: z.boolean(),
  documentType: z.string(),
  jurisdiction: z.string(),
  notes: z.string().nullable(),
  reviewStatus: ReviewStatusSchema,
});

export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;
export type PrioritySourceMetadataIntake = z.infer<typeof PrioritySourceMetadataIntakeSchema>;
