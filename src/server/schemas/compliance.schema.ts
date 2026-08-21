import { z } from 'zod';
import { JURISDICTION_CODES } from '@/types/jurisdiction';

/**
 * Compliance Schemas
 * 
 * Zod validation schemas for compliance query operations with RAG.
 */

/**
 * Submit compliance query
 * 
 * @example
 * {
 *   question: "What are the KYC requirements for mobile lending?",
 *   organizationType: "FINTECH",
 *   industry: "Mobile Lending",
 *   context: "We are launching a new product..."
 * }
 */
export const complianceQuerySchema = z.object({
  question: z.string().min(10).max(1000),
  mode: z.enum(['SINGLE', 'COMPARE']).optional(),
  jurisdictions: z.array(z.enum(JURISDICTION_CODES)).max(1).optional(),
  organizationType: z.enum(['FINTECH', 'BANK', 'TELECOM', 'INSURANCE', 'OTHER']).optional(),
  industry: z.string().max(100).optional(),
  context: z.string().max(2000).optional(),
  answerDetail: z.enum(['standard', 'detailed']).default('standard'),
});

export type ComplianceQueryInput = z.infer<typeof complianceQuerySchema>;

/**
 * Search legal documents
 */
export const searchDocumentsSchema = z.object({
  query: z.string().min(3).max(500),
  limit: z.number().min(1).max(50).default(10),
  filter: z
    .object({
      documentType: z.string().optional(),
      regulatoryArea: z.string().optional(),
      dateFrom: z.date().optional(),
      dateTo: z.date().optional(),
    })
    .optional(),
});

export type SearchDocumentsInput = z.infer<typeof searchDocumentsSchema>;

/**
 * Get query history
 */
export const getQueryHistorySchema = z.object({
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(20),
});

export type GetQueryHistoryInput = z.infer<typeof getQueryHistorySchema>;

/**
 * Get query by ID
 */
export const getQuerySchema = z.object({
  id: z.string(),
});

export type GetQueryInput = z.infer<typeof getQuerySchema>;

/**
 * Follow-up query
 */
export const followUpQuerySchema = z.object({
  originalQueryId: z.string(),
  question: z.string().min(10).max(1000),
});

export type FollowUpQueryInput = z.infer<typeof followUpQuerySchema>;

/**
 * Quick compliance check
 */
export const quickCheckSchema = z.object({
  scenario: z.string().min(20).max(500),
  organizationType: z.enum(['FINTECH', 'BANK', 'TELECOM', 'INSURANCE', 'OTHER']),
});

export type QuickCheckInput = z.infer<typeof quickCheckSchema>;

/**
 * Get suggested queries for the active user
 */
export const getSuggestedQueriesSchema = z.object({});

export type GetSuggestedQueriesInput = z.infer<typeof getSuggestedQueriesSchema>;

/**
 * Record a suggestion click (telemetry)
 */
export const recordSuggestionClickSchema = z.object({
  suggestionId: z.string().min(1),
  suggestionText: z.string().min(1).max(500).optional(),
  surface: z.enum(['empty_state', 'sidebar', 'dashboard', 'other']).default('other'),
});

export type RecordSuggestionClickInput = z.infer<typeof recordSuggestionClickSchema>;
