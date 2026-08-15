/**
 * Corpus Manifest Schema
 *
 * Defines the Zod schema and TypeScript types for per-country corpus manifest
 * files. Each manifest lives at `documents/<country>/manifest.json` and
 * declares every document that belongs to that country's regulatory corpus.
 *
 * Phase 2 — read-only validation and inventory. Does NOT drive ingestion yet.
 */

import { z } from 'zod';

// ============================================================================
// Enum Unions
// ============================================================================

export const CountryEnum = z.enum(['Kenya', 'Malawi', 'Nigeria', 'Rwanda', 'International']);
export type Country = z.infer<typeof CountryEnum>;

export const JurisdictionCodeEnum = z.enum(['KE', 'MW', 'NG', 'RW', 'INTL', 'EU', 'GLOBAL']);
export type JurisdictionCode = z.infer<typeof JurisdictionCodeEnum>;

export const ScopeEnum = z.enum(['COUNTRY', 'INTERNATIONAL', 'REGIONAL']);
export type Scope = z.infer<typeof ScopeEnum>;

export const CategoryEnum = z.enum([
  'core',
  'payments',
  'banking',
  'microfinance',
  'aml-cft',
  'data-protection',
  'cybersecurity',
  'consumer-protection',
  'capital-markets',
  'digital-lending',
  'open-banking',
  'insurance',
  'tax',
  'ai-governance',
  'cloud',
  'ict',
  'accessibility',
  'guidance',
  'other',
]);
export type Category = z.infer<typeof CategoryEnum>;

export const DocumentTypeEnum = z.enum([
  'ACT',
  'REGULATION',
  'GUIDELINE',
  'DIRECTIVE',
  'CIRCULAR',
  'FRAMEWORK',
  'POLICY',
  'STANDARD',
  'REPORT',
  'DRAFT',
  'CHECKLIST',
  'OTHER',
]);
export type DocumentType = z.infer<typeof DocumentTypeEnum>;

export const AuthorityStatusEnum = z.enum([
  'IN_FORCE',
  'DRAFT',
  'SUPERSEDED',
  'CONSULTATION',
  'GUIDANCE',
  'REPORT',
  'UNKNOWN',
]);
export type AuthorityStatus = z.infer<typeof AuthorityStatusEnum>;

export const ReviewStatusEnum = z.enum([
  'APPROVED',
  'REJECTED',
  'NEEDS_REVIEW',
  'SUPERSEDED',
  'PLACEHOLDER',
]);
export type ReviewStatus = z.infer<typeof ReviewStatusEnum>;

export const PriorityEnum = z.enum(['P0', 'P1', 'P2', 'UNKNOWN']);
export type Priority = z.infer<typeof PriorityEnum>;

// ============================================================================
// Valid country → jurisdictionCode mappings
// ============================================================================

export const COUNTRY_JURISDICTION_MAP: Record<Country, JurisdictionCode[]> = {
  Kenya: ['KE'],
  Malawi: ['MW'],
  Nigeria: ['NG'],
  Rwanda: ['RW'],
  International: ['INTL', 'EU', 'GLOBAL'],
};

// ============================================================================
// Manifest Entry Schema (single document)
// ============================================================================

export const CorpusManifestEntrySchema = z
  .object({
    // ---- Required ----
    id: z.string().min(1, 'id must not be empty'),
    country: CountryEnum,
    jurisdictionCode: JurisdictionCodeEnum,
    scope: ScopeEnum,
    category: CategoryEnum,
    regulator: z.string().min(1, 'regulator must not be empty'),
    title: z.string().min(1, 'title must not be empty'),
    documentType: DocumentTypeEnum,
    authorityStatus: AuthorityStatusEnum,
    isBinding: z.boolean(),
    localPath: z.string().min(1, 'localPath must not be empty'),
    sourceUrl: z.string().nullable(),
    checksumSha256: z.string().nullable(),
    reviewStatus: ReviewStatusEnum,
    priority: PriorityEnum,
    tags: z.array(z.string()),

    // ---- Optional ----
    effectiveDate: z.string().nullable().optional(),
    publicationDate: z.string().nullable().optional(),
    version: z.string().nullable().optional(),
    language: z.string().optional(),
    supersedes: z.string().nullable().optional(),
    frameworkSlugs: z.array(z.string()).optional(),
    notes: z.string().nullable().optional(),
    discoveredFrom: z.string().nullable().optional(),
    retrievedAt: z.string().nullable().optional(),
  })
  .superRefine((entry, ctx) => {
    // ---- localPath safety ----
    if (entry.localPath.includes('..')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['localPath'],
        message: 'localPath must not contain ".." (path traversal)',
      });
    }

    if (/^[A-Za-z]:/.test(entry.localPath) || entry.localPath.startsWith('/')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['localPath'],
        message: 'localPath must be relative (no absolute paths)',
      });
    }

    if (entry.localPath.includes('\\')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['localPath'],
        message: 'localPath must use forward slashes only',
      });
    }

    if (!entry.localPath.startsWith('documents/')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['localPath'],
        message: 'localPath must start with "documents/"',
      });
    }

    // ---- jurisdictionCode must match country ----
    const allowed = COUNTRY_JURISDICTION_MAP[entry.country];
    if (allowed && !allowed.includes(entry.jurisdictionCode)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['jurisdictionCode'],
        message: `jurisdictionCode "${entry.jurisdictionCode}" does not match country "${entry.country}" (expected: ${allowed.join(', ')})`,
      });
    }

    // ---- APPROVED integrity ----
    if (entry.reviewStatus === 'APPROVED') {
      if (!entry.sourceUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sourceUrl'],
          message: 'sourceUrl is required when reviewStatus is APPROVED',
        });
      }
      if (!entry.checksumSha256) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['checksumSha256'],
          message: 'checksumSha256 is required when reviewStatus is APPROVED',
        });
      }
      if (entry.authorityStatus === 'UNKNOWN') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['authorityStatus'],
          message: 'authorityStatus must not be UNKNOWN when reviewStatus is APPROVED',
        });
      }
      if (entry.priority === 'UNKNOWN') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['priority'],
          message: 'priority must not be UNKNOWN when reviewStatus is APPROVED',
        });
      }
    }

    // ---- Binding consistency ----
    const nonBindingStatuses: AuthorityStatus[] = ['DRAFT', 'CONSULTATION', 'REPORT'];
    if (nonBindingStatuses.includes(entry.authorityStatus) && entry.isBinding) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['isBinding'],
        message: `isBinding should normally be false when authorityStatus is "${entry.authorityStatus}"`,
      });
    }
  });

export type CorpusManifestEntry = z.infer<typeof CorpusManifestEntrySchema>;

// ============================================================================
// Manifest File Schema (wrapper with metadata)
// ============================================================================

export const CorpusManifestSchema = z.object({
  version: z.number().int().positive(),
  country: CountryEnum,
  jurisdictionCode: JurisdictionCodeEnum,
  entries: z.array(CorpusManifestEntrySchema),
});

export type CorpusManifest = z.infer<typeof CorpusManifestSchema>;
