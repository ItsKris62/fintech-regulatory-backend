import { z } from 'zod';

// =============================================================================
// Enterprise Policy Generator — Zod Input Schemas
// =============================================================================

/**
 * Supported policy types for generation.
 */
export const PolicyTypeEnum = z.enum([
  'DATA_PROTECTION',
  'AML_CFT',
  'IT_SECURITY',
  'CONSUMER_PROTECTION',
  'CYBERSECURITY',
  'CUSTOM',
]);
export type PolicyType = z.infer<typeof PolicyTypeEnum>;

/**
 * Input schema for creating a new enterprise policy draft.
 *
 * This is the initial mutation — it creates the DB record and
 * (in a future phase) fires the async generation pipeline.
 */
export const createDraftSchema = z.object({
  /** Policy type to generate */
  policyType: PolicyTypeEnum,

  /** Human-readable title (auto-generated if omitted) */
  title: z.string().min(3).max(255),

  /** Optional description / scope notes */
  description: z.string().max(2000).optional(),

  /** Target audience for the policy (e.g. "All employees", "IT department") */
  targetAudience: z.string().max(500).optional(),

  /** Organization type context (e.g. "Digital Lender", "Payment Service Provider") */
  organizationType: z.string().max(255).optional(),

  /** Regulatory frameworks to target (e.g. ["DPA 2019", "POCAMLA"]) */
  regulatoryFrameworks: z.array(z.string().min(1).max(100)).min(1).max(10),

  /** Jurisdiction — defaults to "Kenya" */
  jurisdiction: z.string().max(100).default('Kenya'),

  // --- Gap-to-Policy linkage (optional) ---

  /** Link to a source GapAnalysis record */
  sourceGapAnalysisId: z.string().cuid().optional(),

  /** Specific gap item ID within the analysis results JSON */
  sourceGapId: z.string().max(100).optional(),
});
export type CreateDraftInput = z.infer<typeof createDraftSchema>;

/**
 * Input schema for fetching a single policy by ID.
 */
export const getPolicySchema = z.object({
  policyId: z.string().cuid(),
});
export type GetPolicyInput = z.infer<typeof getPolicySchema>;

/**
 * Input schema for listing user's generated policies.
 */
export const listPoliciesSchema = z.object({
  /** Filter by status */
  status: z.enum([
    'INITIALIZING',
    'OUTLINING',
    'DRAFTING',
    'REVIEWING',
    'COMPLETED',
    'FAILED',
    'ARCHIVED',
  ]).optional(),

  /** Filter by policy type */
  policyType: PolicyTypeEnum.optional(),

  /** Pagination */
  cursor: z.string().cuid().optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type ListPoliciesInput = z.infer<typeof listPoliciesSchema>;

/**
 * Input schema for updating a single section's content (TipTap JSON).
 */
export const updateSectionContentSchema = z.object({
  /** The generated policy ID */
  policyId: z.string().cuid(),

  /** The section ID within the sections JSON (e.g. "s1") */
  sectionId: z.string().min(1).max(50),

  /** Updated TipTap JSON content for this section */
  content: z.any(), // TipTap JSON — runtime-validated but schema is opaque

  /** Optional markdown fallback for export */
  contentMarkdown: z.string().optional(),
});
export type UpdateSectionContentInput = z.infer<typeof updateSectionContentSchema>;

/**
 * Input schema for getting pipeline status (polling).
 */
export const getStatusSchema = z.object({
  policyId: z.string().cuid(),
});
export type GetStatusInput = z.infer<typeof getStatusSchema>;

/**
 * Input schema for deleting (soft-archiving) a generated policy.
 */
export const deletePolicySchema = z.object({
  policyId: z.string().cuid(),
});
export type DeletePolicyInput = z.infer<typeof deletePolicySchema>;

export const exportGeneratedPolicySchema = z.object({
  policyId: z.string().cuid(),
  format: z.enum(['DOCX', 'PDF']),
});
export type ExportGeneratedPolicyInput = z.infer<typeof exportGeneratedPolicySchema>;
