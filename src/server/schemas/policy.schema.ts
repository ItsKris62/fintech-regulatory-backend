import { z } from 'zod';

/**
 * Policy Schemas
 * 
 * Zod validation schemas for policy management and AI generation.
 */

/**
 * Generate policy with AI
 * 
 * @example
 * {
 *   title: "Data Protection Policy for Mobile Lending",
 *   scenario: "We are a mobile lending platform...",
 *   organizationType: "FINTECH",
 *   regulatoryAreas: ["data-protection", "consumer-protection"],
 *   specificRequirements: "Must comply with ODPC guidelines"
 * }
 */
export const generatePolicySchema = z.object({
  title: z.string().min(5).max(200).optional(),
  scenario: z.string().min(50).max(5000),
  organizationType: z.enum(['FINTECH', 'BANK', 'TELECOM', 'INSURANCE', 'OTHER']),
  regulatoryAreas: z.array(z.string()).min(1).max(5),
  specificRequirements: z.string().max(1000).optional(),
  targetAudience: z.string().max(200).optional(),
});

export type GeneratePolicyInput = z.infer<typeof generatePolicySchema>;

/**
 * List policies with filters
 */
export const listPoliciesSchema = z.object({
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(10),
  status: z.enum(['DRAFT', 'GENERATING', 'COMPLETED', 'FAILED']).optional(),
  regulatoryArea: z.string().optional(),
  search: z.string().optional(),
});

export type ListPoliciesInput = z.infer<typeof listPoliciesSchema>;

/**
 * Get policy by ID
 */
export const getPolicySchema = z.object({
  id: z.string(),
});

export type GetPolicyInput = z.infer<typeof getPolicySchema>;

/**
 * Update policy
 */
export const updatePolicySchema = z.object({
  id: z.string(),
  title: z.string().min(5).max(200).optional(),
  content: z.string().optional(),
  status: z.enum(['DRAFT', 'GENERATING', 'COMPLETED', 'FAILED']).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

export type UpdatePolicyInput = z.infer<typeof updatePolicySchema>;

/**
 * Delete policy
 */
export const deletePolicySchema = z.object({
  id: z.string(),
});

export type DeletePolicyInput = z.infer<typeof deletePolicySchema>;

/**
 * Export policy
 */
export const exportPolicySchema = z.object({
  id: z.string(),
  format: z.enum(['PDF', 'DOCX', 'MD']).default('DOCX'),
});

export type ExportPolicyInput = z.infer<typeof exportPolicySchema>;

/**
 * Refine policy with AI
 */
export const refinePolicySchema = z.object({
  id: z.string(),
  refinementInstructions: z.string().min(10).max(1000),
});

export type RefinePolicyInput = z.infer<typeof refinePolicySchema>;

/**
 * Verify policy citations
 */
export const verifyCitationsSchema = z.object({
  id: z.string(),
});

export type VerifyCitationsInput = z.infer<typeof verifyCitationsSchema>;
