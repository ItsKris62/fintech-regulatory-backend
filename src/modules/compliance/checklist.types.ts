/**
 * Compliance Checklist — Types, Zod Schemas, and Constants
 *
 * Covers the normalized ChecklistItem model (new path, post-March 2026).
 * Legacy JSON-blob checklists (checklistData / itemProgress) continue to
 * work via the existing ComplianceModule methods and are detected at runtime
 * via `isNormalizedChecklist()` in checklist.service.ts.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Status Constants
// These mirror the ChecklistStatus and related enums proposed in the schema.
// Kept as plain string-constant maps so they compile before `prisma generate`
// runs after `prisma db push`.
// ---------------------------------------------------------------------------

export const CHECKLIST_STATUS = {
  GENERATING:  'GENERATING',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED:   'COMPLETED',
  FAILED:      'FAILED',
} as const;

export type ChecklistStatus = (typeof CHECKLIST_STATUS)[keyof typeof CHECKLIST_STATUS];

export const CHECKLIST_ITEM_STATUS = {
  PENDING:        'PENDING',
  IN_PROGRESS:    'IN_PROGRESS',
  COMPLETED:      'COMPLETED',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
} as const;

export type ChecklistItemStatus =
  (typeof CHECKLIST_ITEM_STATUS)[keyof typeof CHECKLIST_ITEM_STATUS];

export const CHECKLIST_ITEM_PRIORITY = {
  CRITICAL: 'CRITICAL',
  HIGH:     'HIGH',
  MEDIUM:   'MEDIUM',
  LOW:      'LOW',
} as const;

export type ChecklistItemPriority =
  (typeof CHECKLIST_ITEM_PRIORITY)[keyof typeof CHECKLIST_ITEM_PRIORITY];

// ---------------------------------------------------------------------------
// Timing Constants
// ---------------------------------------------------------------------------

/**
 * Maximum age (ms) of a GENERATING checklist before the lazy-evaluation stale
 * cleanup marks it FAILED.  Must be ≥ the AI client timeout (120 s) plus
 * reasonable DB/RAG overhead.
 */
export const CHECKLIST_STALE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Input Schemas
// ---------------------------------------------------------------------------

export const generateChecklistAsyncInputSchema = z.object({
  productType:        z.string().min(1).max(100),
  businessStage:      z.string().min(1).max(100),
  targetSegments:     z.array(z.string().min(1)).min(1).max(10),
  servicesOffered:    z.array(z.string().min(1)).min(1).max(20),
  additionalConcerns: z.string().max(1000).optional(),
});

export type GenerateChecklistAsyncInput = z.infer<typeof generateChecklistAsyncInputSchema>;

export const updateChecklistItemInputSchema = z.object({
  checklistId: z.string().min(1),
  itemId:      z.string().min(1),
  status:      z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'NOT_APPLICABLE']),
  notes:       z.string().max(2000).optional(),
});

export type UpdateChecklistItemInput = z.infer<typeof updateChecklistItemInputSchema>;

export const getChecklistStatusInputSchema = z.object({
  checklistId: z.string().min(1),
});

export type GetChecklistStatusInput = z.infer<typeof getChecklistStatusInputSchema>;

// ---------------------------------------------------------------------------
// Output Types
// ---------------------------------------------------------------------------

export interface ChecklistGenerateResult {
  checklistId: string;
  /** Always GENERATING on initial response — frontend polls getChecklistStatus. */
  status: 'GENERATING';
}

export interface ChecklistStatusResult {
  checklistId: string;
  status:       ChecklistStatus;
  progress:     number;
  completedItems: number;
  totalItems:   number;
  title:        string;
  createdAt:    Date;
  /** True when normalized ChecklistItem records exist for this checklist. */
  isNormalized: boolean;
}

export interface ChecklistSummary {
  id:                 string;
  title:              string;
  productType:        string | null;
  businessStage:      string | null;
  targetSegments:     unknown;
  servicesOffered:    unknown;
  additionalConcerns: string | null;
  progress:           number;
  completedItems:     number;
  totalItems:         number;
  criticalItems:      number;
  status:             ChecklistStatus;
  generatedAt:        Date | null;
  createdAt:          Date;
  updatedAt:          Date;
  /** True when normalized ChecklistItem records exist for this checklist. */
  isNormalized:       boolean;
}

export interface ChecklistItemDetail {
  id:                  string;
  category:            string;
  itemCode:            string | null;
  title:               string;
  description:         string;
  guidance:            string | null;
  regulatoryReference: string;
  actionItems:         string[];
  deadline:            string | null;
  penalty:             string | null;
  priority:            ChecklistItemPriority;
  status:              ChecklistItemStatus;
  notes:               string | null;
  order:               number;
  completedAt:         Date | null;
  completedById:       string | null;
}

export interface ChecklistCategoryDetail {
  name:           string;
  items:          ChecklistItemDetail[];
  completedCount: number;
  totalCount:     number;
  /** 0–100 percentage. */
  progress:       number;
}

export interface ChecklistDetail {
  id:                 string;
  title:              string;
  productType:        string | null;
  businessStage:      string | null;
  targetSegments:     unknown;
  servicesOffered:    unknown;
  additionalConcerns: string | null;
  progress:           number;
  completedItems:     number;
  totalItems:         number;
  status:             ChecklistStatus;
  summary:            unknown;
  metadata:           unknown;
  generatedAt:        Date | null;
  createdAt:          Date;
  updatedAt:          Date;
  completedAt:        Date | null;
  isNormalized:       true;
  categories:         ChecklistCategoryDetail[];
}

export interface UpdateItemResult {
  item: {
    id:          string;
    status:      ChecklistItemStatus;
    notes:       string | null;
    completedAt: Date | null;
  };
  checklist: {
    id:             string;
    progress:       number;
    completedItems: number;
    status:         ChecklistStatus;
    completedAt:    Date | null;
  };
}

// ---------------------------------------------------------------------------
// Internal DB row shape for ChecklistItem
// Mirrors the Prisma ChecklistItem type; used in mapRawItemToDetail.
// ---------------------------------------------------------------------------

export interface RawChecklistItemRow {
  id:                  string;
  checklistId:         string;
  category:            string;
  itemCode:            string | null;
  title:               string;
  description:         string;
  guidance:            string | null;
  regulatoryReference: string;
  actionItems:         unknown; // stored as JSON
  deadline:            string | null;
  penalty:             string | null;
  priority:            string;
  status:              string;
  notes:               string | null;
  order:               number;
  completedAt:         Date | null;
  completedById:       string | null;
  createdAt:           Date;
  updatedAt:           Date;
}

/**
 * Safely cast a JSON-stored value to string[].
 * Returns [] for non-arrays or mixed-type values.
 */
export function safeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string');
}
