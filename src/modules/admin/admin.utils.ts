/**
 * Admin Module Utilities
 */

import { z } from 'zod';
import type { AdminUserDetail, AdminOrgDetail, AuditLogEntry } from './admin.types';
import { subscriptionTierToPlan } from '@/utils/plan-mapping';

// ============================================================================
// Validation Schemas
// ============================================================================

export const adminUserFiltersSchema = z.object({
  role: z.enum(['REGULATOR', 'STARTUP', 'ENTERPRISE', 'ADMIN']).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'PENDING_VERIFICATION']).optional(),
  organizationId: z.string().optional(),
  search: z.string().optional(),
  page: z.number().int().positive().default(1),
  limit: z.number().int().min(1).max(100).default(20),
  sortBy: z.enum(['createdAt', 'email', 'lastLoginAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const adminOrgFiltersSchema = z.object({
  subscriptionTier: z.string().optional(),
  subscriptionStatus: z.string().optional(),
  search: z.string().optional(),
  page: z.number().int().positive().default(1),
  limit: z.number().int().min(1).max(100).default(20),
});

export const suspendUserSchema = z.object({
  reason: z.string().min(10).max(500),
});

export const deleteUserSchema = z.object({
  reason: z.string().min(10).max(500),
});

export const frameworkSchema = z.object({
  name: z.string().min(3).max(200),
  description: z.string().min(10).max(2000),
  area: z.string().min(2).max(100),
  country: z.string().default('Kenya'),
  effectiveDate: z.string().datetime().optional(),
  status: z.enum(['active', 'draft', 'deprecated']).default('active'),
  documentIds: z.array(z.string()).default([]),
});

export const auditLogFiltersSchema = z.object({
  userId: z.string().optional(),
  action: z.string().optional(),
  entityType: z.string().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  page: z.number().int().positive().default(1),
  limit: z.number().int().min(1).max(200).default(50),
});

export const systemConfigUpdateSchema = z.object({
  maintenanceMode: z.boolean().optional(),
  maintenanceMessage: z.string().optional(),
  maxFileUploadMB: z.number().min(1).max(500).optional(),
  maxQueriesPerHour: z.number().min(1).max(1000).optional(),
  maxPoliciesPerHour: z.number().min(1).max(100).optional(),
  allowNewRegistrations: z.boolean().optional(),
  requireEmailVerification: z.boolean().optional(),
  defaultSubscriptionTier: z.string().optional(),
  supportEmail: z.string().email().optional(),
});

// ============================================================================
// Transformers
// ============================================================================

export function toAdminUserDetail(
  user: Record<string, unknown>,
  counts: { sessions: number; policies: number; queries: number }
): AdminUserDetail {
  const org = user.organization as Record<string, unknown> | null;
  return {
    id: user.id as string,
    email: user.email as string,
    fullName: user.fullName as string,
    phone: user.phone as string | null,
    role: user.role as string,
    status: user.status as string,
    emailVerified: user.emailVerified as boolean,
    organizationId: user.organizationId as string | null,
    organizationName: org ? (org.name as string) : null,
    organizationPlan: org ? resolveOrganizationPlan(org) : null,
    lastLoginAt: user.lastLoginAt as Date | null,
    lastLoginIp: user.lastLoginIp as string | null,
    createdAt: user.createdAt as Date,
    updatedAt: user.updatedAt as Date,
    sessionCount: counts.sessions,
    policyCount: counts.policies,
    queryCount: counts.queries,
  };
}

export function toAdminOrgDetail(
  org: Record<string, unknown>,
  counts: { members: number; documents: number; policies: number }
): AdminOrgDetail {
  const plan = resolveOrganizationPlan(org);
  const users = Array.isArray(org.users)
    ? (org.users as Record<string, unknown>[]).map((user) => ({
        id: user.id as string,
        fullName: user.fullName as string,
        email: user.email as string,
        role: user.role as string,
        status: user.status as string,
        createdAt: user.createdAt as Date,
      }))
    : [];

  return {
    id: org.id as string,
    name: org.name as string,
    type: org.type as string,
    organizationType: (org.organizationType as string | undefined) ?? (org.type as string),
    registrationNumber: org.registrationNumber as string | null,
    cbkLicenseNumber: org.cbkLicenseNumber as string | null,
    website: org.website as string | null,
    industry: org.industry as string | null,
    size: org.size as string | null,
    verificationStatus: org.verificationStatus as string,
    address: org.address as string | null,
    contactPerson: org.contactPerson as string | null,
    contactPosition: org.contactPosition as string | null,
    contactEmail: org.contactEmail as string | null,
    contactPhone: org.contactPhone as string | null,
    subscriptionTier: plan,
    plan,
    subscriptionStatus: org.subscriptionStatus as string,
    trialEndsAt: org.trialEndsAt as Date | null,
    gracePeriodEndsAt: org.gracePeriodEndsAt as Date | null,
    cancelledAt: org.cancelledAt as Date | null,
    subscriptionEndsAt: org.subscriptionEndsAt as Date | null,
    planStartDate: org.planStartDate as Date | null,
    planEndDate: org.planEndDate as Date | null,
    maxSeats: typeof org.maxSeats === 'number' ? org.maxSeats : 0,
    memberCount: counts.members,
    documentCount: counts.documents,
    policyCount: counts.policies,
    users,
    createdAt: org.createdAt as Date,
    updatedAt: org.updatedAt as Date,
  };
}

function resolveOrganizationPlan(org: Record<string, unknown>): string {
  if (typeof org.plan === 'string' && org.plan.length > 0) {
    return org.plan;
  }

  if (typeof org.subscriptionTier === 'string' && org.subscriptionTier.length > 0) {
    return subscriptionTierToPlan(org.subscriptionTier)?.toString() ?? org.subscriptionTier.toUpperCase();
  }

  return 'REGULATOR';
}

export function toAuditLogEntry(log: Record<string, unknown>): AuditLogEntry {
  return {
    id: log.id as string,
    userId: log.userId as string | null,
    action: log.action as string,
    entityType: log.entityType as string | null,
    entityId: log.entityId as string | null,
    metadata: log.metadata,
    ipAddress: log.ipAddress as string | null,
    createdAt: log.createdAt as Date,
  };
}

// ============================================================================
// Cache Key Helpers
// ============================================================================

export function featureFlagsKey(): string {
  return 'admin:feature_flags';
}

export function systemConfigKey(): string {
  return 'admin:system_config';
}

export function maintenanceKey(): string {
  return 'admin:maintenance';
}

export function impersonationKey(token: string): string {
  return `admin:impersonate:${token}`;
}

export function frameworksKey(): string {
  return 'admin:regulatory_frameworks';
}

export function orgStatsKey(): string {
  return 'admin:org_stats';
}
