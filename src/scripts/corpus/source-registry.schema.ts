/**
 * Source Registry Schema
 *
 * Defines the Zod schema for official-source registries. Each country has a
 * JSON registry of regulator/authority websites that may publish legal and
 * regulatory documents relevant to the SheriaBot corpus.
 *
 * Phase 3 — discovery and download automation.
 */

import { z } from 'zod';

// ============================================================================
// Enums
// ============================================================================

export const SourceCountryEnum = z.enum(['Malawi', 'Nigeria']);
export type SourceCountry = z.infer<typeof SourceCountryEnum>;

export const SourceJurisdictionCodeEnum = z.enum(['MW', 'NG']);
export type SourceJurisdictionCode = z.infer<typeof SourceJurisdictionCodeEnum>;

export const SourceTypeEnum = z.enum([
  'REGULATOR',
  'FIU',
  'DATA_PROTECTION_AUTHORITY',
  'SECURITIES_REGULATOR',
  'CONSUMER_PROTECTION_AUTHORITY',
  'LEGAL_DATABASE',
  'GOVERNMENT_PORTAL',
  'OTHER',
]);
export type SourceType = z.infer<typeof SourceTypeEnum>;

export const CrawlModeEnum = z.enum([
  'link-discovery',
  'publication-table',
  'static-list',
  'manual-only',
]);
export type CrawlMode = z.infer<typeof CrawlModeEnum>;

export const SourcePriorityEnum = z.enum(['P0', 'P1', 'P2']);
export type SourcePriority = z.infer<typeof SourcePriorityEnum>;

// ============================================================================
// Country ↔ JurisdictionCode mapping
// ============================================================================

export const SOURCE_COUNTRY_JURISDICTION_MAP: Record<SourceCountry, SourceJurisdictionCode> = {
  Malawi: 'MW',
  Nigeria: 'NG',
};

// ============================================================================
// Source Registry Entry Schema
// ============================================================================

export const SourceRegistryEntrySchema = z
  .object({
    id: z.string().min(1, 'id must not be empty'),
    country: SourceCountryEnum,
    jurisdictionCode: SourceJurisdictionCodeEnum,
    regulator: z.string().min(1, 'regulator must not be empty'),
    sourceType: SourceTypeEnum,
    baseUrl: z.string().url('baseUrl must be a valid URL'),
    allowedDomains: z.array(z.string().min(1)).min(1, 'at least one allowed domain required'),
    categories: z.array(z.string()),
    crawlMode: CrawlModeEnum,
    priority: SourcePriorityEnum,
    enabled: z.boolean(),
    notes: z.string().optional(),
  })
  .superRefine((entry, ctx) => {
    const expected = SOURCE_COUNTRY_JURISDICTION_MAP[entry.country];
    if (expected && entry.jurisdictionCode !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['jurisdictionCode'],
        message: `jurisdictionCode "${entry.jurisdictionCode}" does not match country "${entry.country}" (expected: ${expected})`,
      });
    }
  });

export type SourceRegistryEntry = z.infer<typeof SourceRegistryEntrySchema>;

// ============================================================================
// Source Registry File Schema
// ============================================================================

export const SourceRegistrySchema = z.object({
  version: z.number().int().positive(),
  country: SourceCountryEnum,
  jurisdictionCode: SourceJurisdictionCodeEnum,
  sources: z.array(SourceRegistryEntrySchema),
});

export type SourceRegistry = z.infer<typeof SourceRegistrySchema>;
