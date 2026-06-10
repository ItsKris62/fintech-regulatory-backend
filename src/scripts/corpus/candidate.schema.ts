/**
 * Candidate Manifest Schema
 *
 * Defines the Zod schema for candidate document manifests. Candidates are
 * documents discovered from official sources that require human review before
 * becoming part of the production corpus.
 *
 * Candidate manifests live under `documents/_incoming/<country>/candidate-manifest.json`.
 */

import { z } from 'zod';

import {
  DocumentTypeEnum,
  AuthorityStatusEnum,
  CategoryEnum,
} from './manifest.schema';

// ============================================================================
// Candidate-specific enums
// ============================================================================

export const CandidateDecisionEnum = z.enum([
  'NEEDS_REVIEW',
  'APPROVED',
  'REJECTED',
  'SUPERSEDED',
  'DUPLICATE',
]);
export type CandidateDecision = z.infer<typeof CandidateDecisionEnum>;

export const CandidateCountryEnum = z.enum(['Malawi', 'Nigeria']);
export type CandidateCountry = z.infer<typeof CandidateCountryEnum>;

export const CandidateJurisdictionCodeEnum = z.enum(['MW', 'NG']);
export type CandidateJurisdictionCode = z.infer<typeof CandidateJurisdictionCodeEnum>;

export const CandidatePriorityEnum = z.enum(['P0', 'P1', 'P2', 'UNKNOWN']);
export type CandidatePriority = z.infer<typeof CandidatePriorityEnum>;

// ============================================================================
// Country ↔ JurisdictionCode mapping
// ============================================================================

export const CANDIDATE_COUNTRY_JURISDICTION_MAP: Record<CandidateCountry, CandidateJurisdictionCode> = {
  Malawi: 'MW',
  Nigeria: 'NG',
};

// ============================================================================
// Candidate Entry Schema
// ============================================================================

export const CandidateEntrySchema = z
  .object({
    id: z.string().min(1, 'id must not be empty'),
    country: CandidateCountryEnum,
    jurisdictionCode: CandidateJurisdictionCodeEnum,
    discoveredTitle: z.string().min(1, 'discoveredTitle must not be empty'),
    normalizedTitle: z.string().min(1, 'normalizedTitle must not be empty'),
    sourceUrl: z.string().url('sourceUrl must be a valid URL'),
    sourcePageUrl: z.string().url('sourcePageUrl must be a valid URL'),
    regulator: z.string().min(1, 'regulator must not be empty'),
    suggestedCategory: CategoryEnum,
    suggestedDocumentType: DocumentTypeEnum,
    suggestedAuthorityStatus: AuthorityStatusEnum,
    suggestedIsBinding: z.boolean().nullable(),
    priority: CandidatePriorityEnum,
    decision: CandidateDecisionEnum,
    decisionReason: z.string().nullable().optional(),
    reviewedBy: z.string().nullable().optional(),
    reviewedAt: z.string().nullable().optional(),
    discoveredAt: z.string().min(1, 'discoveredAt must not be empty'),
    contentType: z.string().nullable().optional(),
    fileExtension: z.string().nullable().optional(),
    proposedLocalPath: z.string().nullable().optional(),
    downloadedLocalPath: z.string().nullable().optional(),
    checksumSha256: z.string().nullable().optional(),
    duplicateOf: z.string().nullable().optional(),
    tags: z.array(z.string()),
    notes: z.string().nullable().optional(),
  })
  .superRefine((entry, ctx) => {
    // Country/jurisdiction match
    const expected = CANDIDATE_COUNTRY_JURISDICTION_MAP[entry.country];
    if (expected && entry.jurisdictionCode !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['jurisdictionCode'],
        message: `jurisdictionCode "${entry.jurisdictionCode}" does not match country "${entry.country}" (expected: ${expected})`,
      });
    }

    // If APPROVED, must have proposedLocalPath
    if (entry.decision === 'APPROVED' && !entry.proposedLocalPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proposedLocalPath'],
        message: 'proposedLocalPath is required when decision is APPROVED',
      });
    }

    // proposedLocalPath safety
    if (entry.proposedLocalPath) {
      if (entry.proposedLocalPath.includes('..')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['proposedLocalPath'],
          message: 'proposedLocalPath must not contain ".." (path traversal)',
        });
      }
      if (/^[A-Za-z]:/.test(entry.proposedLocalPath) || entry.proposedLocalPath.startsWith('/')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['proposedLocalPath'],
          message: 'proposedLocalPath must be relative',
        });
      }
      if (entry.proposedLocalPath.includes('\\')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['proposedLocalPath'],
          message: 'proposedLocalPath must use forward slashes',
        });
      }
      if (!entry.proposedLocalPath.startsWith('documents/')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['proposedLocalPath'],
          message: 'proposedLocalPath must start with "documents/"',
        });
      }
    }

    // downloadedLocalPath safety
    if (entry.downloadedLocalPath) {
      if (entry.downloadedLocalPath.includes('..')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['downloadedLocalPath'],
          message: 'downloadedLocalPath must not contain ".."',
        });
      }
      if (!entry.downloadedLocalPath.startsWith('documents/')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['downloadedLocalPath'],
          message: 'downloadedLocalPath must start with "documents/"',
        });
      }
    }
  });

export type CandidateEntry = z.infer<typeof CandidateEntrySchema>;

// ============================================================================
// Candidate Manifest File Schema
// ============================================================================

export const CandidateManifestSchema = z.object({
  version: z.number().int().positive(),
  country: CandidateCountryEnum,
  jurisdictionCode: CandidateJurisdictionCodeEnum,
  discoveredAt: z.string(),
  entries: z.array(CandidateEntrySchema),
});

export type CandidateManifest = z.infer<typeof CandidateManifestSchema>;
