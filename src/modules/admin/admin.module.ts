/**
 * Admin Module
 * Superadmin capabilities: user/org management, content moderation,
 * system configuration, platform monitoring, regulatory framework management.
 *
 * All destructive operations are logged to the AuditLog with before/after state.
 * Impersonation tokens are short-lived (15 min) and stored only in Redis.
 */

import { SubscriptionPlan as PrismaSubscriptionPlan, SubscriptionStatus } from '@prisma/client';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2PrivateClient, r2PrivateBucket } from '@/lib/storage/r2-private-client';
import {
  AlignmentType,
  BorderStyle,
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  ShadingType,
} from 'docx';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import { NotFoundError, ForbiddenError, BadRequestError } from '@/utils/error';
import { subscriptionTierToPlan } from '@/utils/plan-mapping';
import { planCtxCacheKey } from '@/modules/trial';
import { revokeAllUserTokens } from '@/utils/token-revocation';
import { nanoid } from 'nanoid';
import { supabaseAdmin } from '@/lib/supabase';
import { getIndexStats } from '@/lib/rag/client';
import { storageService } from '@/lib/storage/storage.service';
import {
  loadSystemConfig,
  normalizeSystemConfigPatch,
  sanitizeSystemConfigForAudit,
  toAdminSystemConfig,
  updateSystemConfigSnapshot,
} from '@/lib/system-config';
import {
  getBillingPlanCatalog as loadBillingPlanCatalog,
  updateBillingPlanCatalog as persistBillingPlanCatalog,
} from '@/lib/runtime-billing-plans';
import {
  toAdminUserDetail,
  toAdminOrgDetail,
  toAuditLogEntry,
  featureFlagsKey,
  maintenanceKey,
  impersonationKey,
  frameworksKey,
  orgStatsKey,
  systemConfigUpdateSchema,
} from './admin.utils';
import { createUserWithOrganization } from '@/server/services/userProvisioning.service';
import { reactMailer } from '@/lib/email/react-mailer.service';
import { appConfig } from '@/config/app.config';
import {
  ADMIN_CONSTANTS,
  DEFAULT_SYSTEM_CONFIG,
  DEFAULT_FEATURE_FLAGS,
  type AdminUserFilters,
  type AdminOrgFilters,
  type AdminUserDetail,
  type AdminOrgDetail,
  type PaginatedUsers,
  type PaginatedOrganizations,
  type ModerationFilters,
  type ImpersonationToken,
  type SystemConfig,
  type FeatureFlags,
  type MaintenanceStatus,
  type SystemHealth,
  type DatabaseStats,
  type CacheStats,
  type VectorDBStats,
  type StorageStats,
  type ConnectionStats,
  type ErrorLogFilters,
  type PaginatedErrorLog,
  type AuditLogFilters,
  type AuditLogEntry,
  type PaginatedAuditLog,
  type RegulatoryFramework,
  type FrameworkParams,
  type PendingInvitation,
  type BillingPlanCatalog,
  type BillingPlanCatalogUpdateInput,
  type SubscriptionPlan,
  type Subscription,
  type SubscriptionOverview,
  type CreateUserInput,
  type UpdateOrganizationInput,
  type UserGrowthData,
  type RevenueMetrics,
  type AIUsageMetrics,
  type SubscriptionBreakdown,
  type LoginHistoryFilters,
  type LoginHistoryEntry,
  type PaginatedLoginHistory,
  type ContentFilters,
  type ContentItem,
  type PaginatedContent,
  type OrganizationStats,
  type PaymentSummary,
  type OrgPaymentHistory,
  type SessionSummary,
  type AuditLogExportFilters,
  type AdminOperationalOverview,
  type OperationalActivityItem,
  type OperationalStatus,
} from './admin.types';

const { CACHE_TTL } = ADMIN_CONSTANTS;

const CURRENCY_MINOR_UNIT_SCALE = 100;
const SUBSCRIPTION_PLANS: SubscriptionPlan[] = ['REGULATOR', 'STARTUP', 'BUSINESS', 'ENTERPRISE'];
const ORG_TIER_ALIASES: Record<SubscriptionPlan, string[]> = {
  REGULATOR: ['REGULATOR', 'regulator', 'starter', 'free'],
  STARTUP: ['STARTUP', 'startup'],
  BUSINESS: ['BUSINESS', 'business', 'professional', 'growth'],
  ENTERPRISE: ['ENTERPRISE', 'enterprise', 'custom'],
};

const FAILED_QUERY_STATUSES = ['failed', 'error', 'errored', 'FAILED', 'ERROR', 'ERRORED'];
const ROLE_CHANGE_ACTIONS = [
  'admin_update_user_role',
  'admin_update_user',
  'BULK_USER_TIER_CHANGE',
  'admin_update_subscription',
  'admin_update_organization_plan',
];

function normalizeOperationalStatus(status: unknown): OperationalStatus {
  if (status === 'healthy' || status === 'degraded' || status === 'down') return status;
  return 'unknown';
}

function operationalSeverityForAction(action: string): OperationalActivityItem['severity'] {
  const lowered = action.toLowerCase();
  if (lowered.includes('delete') || lowered.includes('suspend') || lowered.includes('failed')) return 'critical';
  if (lowered.includes('reject') || lowered.includes('reset') || lowered.includes('export')) return 'warning';
  return 'info';
}

function toActivityTitle(action: string): string {
  return action
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function toKES(amount: number | bigint | null | undefined): number {
  return Number(amount ?? 0) / CURRENCY_MINOR_UNIT_SCALE;
}

function roundCurrency(amount: number): number {
  return Math.round(amount * 100) / 100;
}

function getSubscriptionTierAliases(planOrTier: string): string[] {
  const normalized = planOrTier.toUpperCase() as SubscriptionPlan;
  return Array.from(new Set([planOrTier, ...(ORG_TIER_ALIASES[normalized] ?? [planOrTier])]));
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfUtcWeek(date: Date): Date {
  const normalized = startOfUtcDay(date);
  const day = normalized.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  normalized.setUTCDate(normalized.getUTCDate() + diff);
  return normalized;
}

function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addUtcMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function formatBucketKey(date: Date, period: 'daily' | 'weekly' | 'monthly'): string {
  if (period === 'monthly') return date.toISOString().slice(0, 7);
  return startOfUtcDay(date).toISOString().slice(0, 10);
}

function buildTimeSeriesKeys(
  period: 'daily' | 'weekly' | 'monthly',
  dateFrom: Date,
  dateTo: Date
): string[] {
  if (dateFrom > dateTo) return [];

  const keys: string[] = [];

  if (period === 'daily') {
    let cursor = startOfUtcDay(dateFrom);
    const end = startOfUtcDay(dateTo);
    while (cursor <= end) {
      keys.push(formatBucketKey(cursor, 'daily'));
      cursor = addUtcDays(cursor, 1);
    }
    return keys;
  }

  if (period === 'weekly') {
    let cursor = startOfUtcWeek(dateFrom);
    const end = startOfUtcWeek(dateTo);
    while (cursor <= end) {
      keys.push(formatBucketKey(cursor, 'weekly'));
      cursor = addUtcDays(cursor, 7);
    }
    return keys;
  }

  let cursor = startOfUtcMonth(dateFrom);
  const end = startOfUtcMonth(dateTo);
  while (cursor <= end) {
    keys.push(formatBucketKey(cursor, 'monthly'));
    cursor = addUtcMonths(cursor, 1);
  }

  return keys;
}

function buildCountSeries(
  period: 'daily' | 'weekly' | 'monthly',
  dateFrom: Date,
  dateTo: Date,
  buckets: Map<string, number>
): Array<{ date: string; count: number }> {
  return buildTimeSeriesKeys(period, dateFrom, dateTo).map((date) => ({
    date,
    count: buckets.get(date) ?? 0,
  }));
}

function buildAmountSeries(
  dateFrom: Date,
  dateTo: Date,
  buckets: Map<string, number>
): Array<{ date: string; amount: number }> {
  return buildTimeSeriesKeys('monthly', dateFrom, dateTo).map((date) => ({
    date,
    amount: roundCurrency(buckets.get(date) ?? 0),
  }));
}

class AdminModule {
  // ==========================================================================
  // USER MANAGEMENT
  // ==========================================================================

  async getAllUsers(filters: AdminUserFilters): Promise<PaginatedUsers> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {
      ...(filters.role && { role: filters.role }),
      ...(filters.status && { status: filters.status }),
      ...(filters.organizationId && { organizationId: filters.organizationId }),
      ...(filters.search && {
        OR: [
          { email: { contains: filters.search, mode: 'insensitive' } },
          { fullName: { contains: filters.search, mode: 'insensitive' } },
        ],
      }),
    };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where: where as any,
        include: { organization: { select: { name: true, subscriptionTier: true, plan: true } } },
        orderBy: { [filters.sortBy ?? 'createdAt']: filters.sortOrder ?? 'desc' },
        skip,
        take: limit,
      }),
      prisma.user.count({
        where: where as any,
      }),
    ]);

    const items = await Promise.all(
      users.map(async (u) => {
        const [sessions, policies, queries] = await Promise.all([
          prisma.session.count({ where: { userId: u.id } }),
          prisma.policy.count({ where: { userId: u.id } }),
          prisma.complianceQuery.count({ where: { userId: u.id } }),
        ]);
        return toAdminUserDetail(u as unknown as Record<string, unknown>, {
          sessions,
          policies,
          queries,
        });
      })
    );

    return {
      items,
      nextCursor: users.length === limit ? String(page + 1) : null,
      total,
      page,
      limit,
    };
  }

  async getUserDetails(userId: string): Promise<AdminUserDetail> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { organization: { select: { name: true, subscriptionTier: true, plan: true } } },
    });
    if (!user) throw new NotFoundError('User');

    const [sessions, policies, queries] = await Promise.all([
      prisma.session.count({ where: { userId } }),
      prisma.policy.count({ where: { userId } }),
      prisma.complianceQuery.count({ where: { userId } }),
    ]);

    return toAdminUserDetail(user as unknown as Record<string, unknown>, {
      sessions,
      policies,
      queries,
    });
  }

  async updateUserRole(
    adminId: string,
    userId: string,
    role: string
  ): Promise<AdminUserDetail> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError('User');

    const before = { role: user.role };
    await prisma.user.update({
      where: { id: userId },
      data: { role: role as never },
    });

    await this.writeAuditLog(adminId, 'admin_update_user_role', 'User', userId, {
      before,
      after: { role },
    });

    return this.getUserDetails(userId);
  }

  async suspendUser(adminId: string, userId: string, reason: string): Promise<AdminUserDetail> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError('User');
    if (user.role === 'ADMIN') throw new ForbiddenError('Cannot suspend an admin user');

    await prisma.user.update({
      where: { id: userId },
      data: { status: 'SUSPENDED', accountStatus: 'suspended' },
    });

    // Invalidate all sessions
    await prisma.session.deleteMany({ where: { userId } });

    await this.writeAuditLog(adminId, 'admin_suspend_user', 'User', userId, { reason });
    logger.info({ type: 'admin_user_suspended', adminId, userId, reason });

    return this.getUserDetails(userId);
  }

  async reactivateUser(adminId: string, userId: string): Promise<AdminUserDetail> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError('User');

    await prisma.user.update({
      where: { id: userId },
      data: { status: 'ACTIVE', accountStatus: 'active' },
    });

    await this.writeAuditLog(adminId, 'admin_reactivate_user', 'User', userId, {});
    return this.getUserDetails(userId);
  }

  async deleteUser(adminId: string, userId: string, reason: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError('User');
    if (user.role === 'ADMIN') throw new ForbiddenError('Cannot delete an admin user');

    // Soft delete  -  anonymize after 30 days
    await prisma.user.update({
      where: { id: userId },
      data: {
        status: 'SUSPENDED',
        accountStatus: 'cancelled',
        email: `deleted_${userId}@sheriabot.internal`,
        deletedAt: new Date(),
      },
    });

    await this.writeAuditLog(adminId, 'admin_delete_user', 'User', userId, { reason });
    logger.info({ type: 'admin_user_deleted', adminId, userId, reason });
  }

  /**
   * Create a short-lived (15 min) impersonation token stored only in Redis.
   */
  async impersonateUser(
    adminId: string,
    targetUserId: string
  ): Promise<ImpersonationToken> {
    const target = await prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target) throw new NotFoundError('User');
    if (target.role === 'ADMIN') throw new ForbiddenError('Cannot impersonate admin users');

    const token = nanoid(48);
    const expiresAt = new Date(Date.now() + CACHE_TTL.IMPERSONATION_TTL * 1000);

    const payload = { adminId, targetUserId, expiresAt: expiresAt.toISOString() };
    await redis.set(
      impersonationKey(token),
      JSON.stringify(payload),
      { ex: CACHE_TTL.IMPERSONATION_TTL }
    );

    await this.writeAuditLog(adminId, 'admin_impersonate_user', 'User', targetUserId, {});

    logger.info({ type: 'admin_impersonation_created', adminId, targetUserId });

    return { token, adminId, targetUserId, expiresAt };
  }

  async forcePasswordReset(adminId: string, userId: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError('User');

    // Invalidate all sessions  -  user must log in and reset password
    await prisma.session.deleteMany({ where: { userId } });

    await this.writeAuditLog(adminId, 'admin_force_password_reset', 'User', userId, {});
    logger.info({ type: 'admin_force_password_reset', adminId, userId });
  }

  async getUserAuditLog(userId: string): Promise<AuditLogEntry[]> {
    const logs = await prisma.auditLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return logs.map((l) => toAuditLogEntry(l as unknown as Record<string, unknown>));
  }

  // ==========================================================================
  // ORGANIZATION MANAGEMENT
  // ==========================================================================

  async getAllOrganizations(filters: AdminOrgFilters): Promise<PaginatedOrganizations> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;
    const search = filters.search?.trim();
    const requestedPlan = filters.subscriptionTier?.trim();
    const mappedPlan = requestedPlan ? subscriptionTierToPlan(requestedPlan) : null;
    const sortBy = filters.sortBy ?? 'createdAt';
    const sortOrder = filters.sortOrder ?? 'desc';

    const where: Record<string, unknown> = {
      ...(filters.subscriptionStatus && { subscriptionStatus: filters.subscriptionStatus }),
      ...(search && {
        name: { contains: search, mode: 'insensitive' },
      }),
    };

    if (requestedPlan) {
      const tierConditions: Record<string, unknown>[] = [
        { subscriptionTier: { in: getSubscriptionTierAliases(requestedPlan) } },
      ];

      if (mappedPlan) {
        tierConditions.unshift({ plan: mappedPlan });
      }

      where['OR'] = tierConditions;
    }

    const orderBy =
      sortBy === 'memberCount'
        ? [{ users: { _count: sortOrder } }, { createdAt: 'desc' }]
        : sortBy === 'name'
          ? [{ name: sortOrder }, { createdAt: 'desc' }]
          : sortBy === 'organizationType'
            ? [{ organizationType: sortOrder }, { name: 'asc' }]
            : sortBy === 'subscriptionTier'
              ? [{ subscriptionTier: sortOrder }, { name: 'asc' }]
              : sortBy === 'subscriptionStatus'
                ? [{ subscriptionStatus: sortOrder }, { name: 'asc' }]
                : [{ createdAt: sortOrder }, { name: 'asc' }];

    const [orgs, total] = await Promise.all([
      prisma.organization.findMany({
        where: where as any,
        orderBy: orderBy as any,
        skip,
        take: limit,
      }),
      prisma.organization.count({
        where: where as any,
      }),
    ]);

    const items = await Promise.all(
      orgs.map(async (org) => {
        const [members, documents, policies] = await Promise.all([
          prisma.user.count({ where: { organizationId: org.id } }),
          prisma.legalDocument.count({ where: { organizationId: org.id, deletedAt: null } }),
          prisma.policy.count({
            where: {
              OR: [{ organizationId: org.id }, { user: { organizationId: org.id } }],
            },
          }),
        ]);
        return toAdminOrgDetail(org as unknown as Record<string, unknown>, {
          members,
          documents,
          policies,
        });
      })
    );

    return {
      items,
      nextCursor: orgs.length === limit ? String(page + 1) : null,
      total,
      page,
      limit,
    };
  }

  async getOrganizationStats(): Promise<OrganizationStats> {
    const cached = await redis.get<string>(orgStatsKey());
    if (cached) return JSON.parse(cached) as OrganizationStats;

    const orgs = await prisma.organization.findMany({
      select: { subscriptionTier: true, subscriptionStatus: true, plan: true },
    });

    const byTier = { REGULATOR: 0, STARTUP: 0, BUSINESS: 0, ENTERPRISE: 0 };
    let active = 0;

    for (const org of orgs) {
      const plan = org.plan ?? subscriptionTierToPlan(org.subscriptionTier) ?? PrismaSubscriptionPlan.REGULATOR;
      if (plan in byTier) {
        byTier[plan as keyof typeof byTier] += 1;
      }
      if (org.subscriptionStatus === 'ACTIVE') {
        active += 1;
      }
    }

    const stats: OrganizationStats = { total: orgs.length, active, byTier };
    await redis.set(orgStatsKey(), JSON.stringify(stats), { ex: CACHE_TTL.ORG_STATS });

    logger.info({ type: 'admin_org_stats_computed', total: orgs.length, active });
    return stats;
  }

  async getOrganizationDetails(orgId: string): Promise<AdminOrgDetail> {
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      include: {
        users: {
          select: {
            id: true,
            fullName: true,
            email: true,
            role: true,
            status: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!org) throw new NotFoundError('Organization');

    const [documents, policies] = await Promise.all([
      prisma.legalDocument.count({ where: { organizationId: orgId, deletedAt: null } }),
      prisma.policy.count({
        where: {
          OR: [{ organizationId: orgId }, { user: { organizationId: orgId } }],
        },
      }),
    ]);

    return toAdminOrgDetail(org as unknown as Record<string, unknown>, {
      members: org.users.length,
      documents,
      policies,
    });
  }

  async getOrgMembers(orgId: string): Promise<{ id: string; fullName: string; email: string; role: string; status: string; createdAt: Date }[]> {
    const members = await prisma.user.findMany({
      where: { organizationId: orgId },
      select: { id: true, fullName: true, email: true, role: true, status: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    return members as unknown as { id: string; fullName: string; email: string; role: string; status: string; createdAt: Date }[];
  }

  async suspendOrganization(
    adminId: string,
    orgId: string,
    reason: string
  ): Promise<AdminOrgDetail> {
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new NotFoundError('Organization');

    await prisma.organization.update({
      where: { id: orgId },
      data: { subscriptionStatus: SubscriptionStatus.SUSPENDED },
    });

    // Suspend all org members
    await prisma.user.updateMany({
      where: { organizationId: orgId },
      data: { status: 'SUSPENDED', accountStatus: 'suspended' },
    });

    await this.writeAuditLog(adminId, 'admin_suspend_org', 'Organization', orgId, { reason });
    logger.info({ type: 'admin_org_suspended', adminId, orgId, reason });
    await this.invalidatePlanCacheForOrg(orgId, 'admin_suspend_org');
    await this.invalidateOrganizationStatsCache();

    return this.getOrganizationDetails(orgId);
  }

  async reactivateOrganization(adminId: string, orgId: string): Promise<AdminOrgDetail> {
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new NotFoundError('Organization');

    await prisma.organization.update({
      where: { id: orgId },
      data: { subscriptionStatus: 'ACTIVE' },
    });

    await prisma.user.updateMany({
      where: { organizationId: orgId, status: 'SUSPENDED', accountStatus: 'suspended' },
      data: { status: 'ACTIVE', accountStatus: 'active' },
    });

    await this.writeAuditLog(adminId, 'admin_reactivate_org', 'Organization', orgId, {});
    await this.invalidateOrganizationStatsCache();
    return this.getOrganizationDetails(orgId);
  }

  async deleteOrganization(adminId: string, orgId: string, reason: string): Promise<void> {
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new NotFoundError('Organization');

    // Soft delete  -  suspend all members
    await this.suspendOrganization(adminId, orgId, reason);
    await this.writeAuditLog(adminId, 'admin_delete_org', 'Organization', orgId, { reason });

    // Hard delete scheduled after retention period (fire-and-forget)
    setTimeout(async () => {
      try {
        await prisma.organization.delete({ where: { id: orgId } });
        logger.info({ type: 'admin_org_hard_deleted', orgId });
      } catch { /* Non-fatal */ }
    }, ADMIN_CONSTANTS.SOFT_DELETE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  }

  async updateOrganizationPlan(
    adminId: string,
    orgId: string,
    plan: SubscriptionPlan
  ): Promise<AdminOrgDetail> {
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new NotFoundError('Organization');

    const prismaplan = PrismaSubscriptionPlan[plan as keyof typeof PrismaSubscriptionPlan];
    const before = { subscriptionTier: org.subscriptionTier, plan: org.plan };

    await prisma.organization.update({
      where: { id: orgId },
      data: {
        subscriptionTier: plan,        // legacy field  -  keep in sync
        plan:             prismaplan,  // authoritative field read by withPlanContext
        subscriptionStatus: SubscriptionStatus.ACTIVE,
      },
    });

    logger.info({
      type:             'plan_sync',
      orgId,
      oldPlan:          before.plan,
      newPlan:          prismaplan,
      subscriptionTier: plan,
      source:           'admin_update_org_plan',
    });

    await this.invalidatePlanCacheForOrg(orgId, 'admin_update_org_plan');
    await this.invalidateOrganizationStatsCache();

    await this.writeAuditLog(adminId, 'admin_update_org_plan', 'Organization', orgId, {
      before,
      after: { plan, prismaplan },
    });

    return this.getOrganizationDetails(orgId);
  }

  async getOrganizationAuditLog(orgId: string): Promise<AuditLogEntry[]> {
    const logs = await prisma.auditLog.findMany({
      where: { user: { organizationId: orgId } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return logs.map((l) => toAuditLogEntry(l as unknown as Record<string, unknown>));
  }

  // ==========================================================================
  // CONTENT MODERATION
  // ==========================================================================

  async getPendingDocuments(filters: ModerationFilters) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    return prisma.legalDocument.findMany({
      where: { contentStatus: 'UNDER_REVIEW', deletedAt: null },
      orderBy: { createdAt: 'asc' },
      skip,
      take: limit,
    });
  }

  async approveDocument(documentId: string, adminId: string) {
    const doc = await prisma.legalDocument.findUnique({ where: { id: documentId } });
    if (!doc) throw new NotFoundError('Document');

    const updated = await prisma.legalDocument.update({
      where: { id: documentId },
      data: { contentStatus: 'PUBLISHED', publishedAt: new Date(), publishedBy: adminId },
    });

    await this.writeAuditLog(adminId, 'admin_approve_document', 'Document', documentId, {});
    return updated;
  }

  async rejectDocument(documentId: string, adminId: string, reason: string) {
    const doc = await prisma.legalDocument.findUnique({ where: { id: documentId } });
    if (!doc) throw new NotFoundError('Document');

    const updated = await prisma.legalDocument.update({
      where: { id: documentId },
      data: { contentStatus: 'DRAFT' },
    });

    await this.writeAuditLog(adminId, 'admin_reject_document', 'Document', documentId, { reason });
    return updated;
  }

  async flagDocument(documentId: string, adminId: string, reason: string) {
    const doc = await prisma.legalDocument.findUnique({ where: { id: documentId } });
    if (!doc) throw new NotFoundError('Document');

    const updated = await prisma.legalDocument.update({
      where: { id: documentId },
      data: { contentStatus: 'UNDER_REVIEW' },
    });

    await this.writeAuditLog(adminId, 'admin_flag_document', 'Document', documentId, { reason });
    return updated;
  }

  async getPendingPolicies(filters: ModerationFilters) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    return prisma.policy.findMany({
      where: { status: 'COMPLETED' },
      orderBy: { createdAt: 'asc' },
      skip,
      take: limit,
    });
  }

  async approvePolicy(policyId: string, adminId: string) {
    const policy = await prisma.policy.findUnique({ where: { id: policyId } });
    if (!policy) throw new NotFoundError('Policy');

    await this.writeAuditLog(adminId, 'admin_approve_policy', 'Policy', policyId, {});
    return policy;
  }

  async rejectPolicy(policyId: string, adminId: string, reason: string) {
    const policy = await prisma.policy.findUnique({ where: { id: policyId } });
    if (!policy) throw new NotFoundError('Policy');

    const updated = await prisma.policy.update({
      where: { id: policyId },
      data: { status: 'ARCHIVED' },
    });

    await this.writeAuditLog(adminId, 'admin_reject_policy', 'Policy', policyId, { reason });
    return updated;
  }

  // ==========================================================================
  // SYSTEM CONFIGURATION
  // ==========================================================================

  async getSystemConfig(): Promise<SystemConfig> {
    const config = await loadSystemConfig({ syncDefinitions: true });
    return toAdminSystemConfig(config);
  }

  async updateSystemConfig(
    adminId: string,
    config: Partial<SystemConfig>
  ): Promise<SystemConfig> {
    const existing = await loadSystemConfig();
    const normalized = normalizeSystemConfigPatch(config as Record<string, unknown>);
    const currentMaskedKey = typeof toAdminSystemConfig(existing).aiApiKeyMasked === 'string'
      ? toAdminSystemConfig(existing).aiApiKeyMasked
      : null;

    if (
      typeof normalized.aiApiKey === 'string'
      && currentMaskedKey
      && normalized.aiApiKey.trim() === currentMaskedKey
    ) {
      delete normalized.aiApiKey;
    }

    const validated = systemConfigUpdateSchema.parse(normalized);
    const merged = { ...existing, ...validated };
    const availableModels = Array.isArray(merged.availableAIModels)
      ? merged.availableAIModels.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];

    if (availableModels.length > 0) {
      for (const key of ['aiPolicyModel', 'aiQueryModel', 'aiVerificationModel', 'aiComplexAnalysisModel'] as const) {
        const selectedModel = merged[key];
        if (typeof selectedModel === 'string' && selectedModel.trim().length > 0 && !availableModels.includes(selectedModel)) {
          throw new BadRequestError(`${key} must be present in availableAIModels.`);
        }
      }
    }

    const updated = await updateSystemConfigSnapshot(validated, adminId);

    await this.writeAuditLog(adminId, 'admin_update_system_config', 'System', 'config', {
      changes: sanitizeSystemConfigForAudit(validated as Record<string, unknown>),
    });

    logger.info({ type: 'admin_system_config_updated', adminId, changes: Object.keys(validated) });
    return toAdminSystemConfig(updated);
  }

  async getFeatureFlags(): Promise<FeatureFlags> {
    const cached = await redis.get<string>(featureFlagsKey());
    if (cached) return JSON.parse(cached) as FeatureFlags;

    const persisted = await redis.get<string>('admin:feature_flags:persisted');
    if (persisted) {
      const flags = JSON.parse(persisted) as FeatureFlags;
      await redis.set(featureFlagsKey(), persisted, { ex: CACHE_TTL.FEATURE_FLAGS });
      return flags;
    }

    await redis.set(
      featureFlagsKey(),
      JSON.stringify(DEFAULT_FEATURE_FLAGS),
      { ex: CACHE_TTL.FEATURE_FLAGS }
    );
    return { ...DEFAULT_FEATURE_FLAGS };
  }

  async updateFeatureFlag(
    adminId: string,
    flag: string,
    enabled: boolean
  ): Promise<FeatureFlags> {
    const existing = await this.getFeatureFlags();
    const updated = { ...existing, [flag]: enabled };

    const serialized = JSON.stringify(updated);
    await redis.set('admin:feature_flags:persisted', serialized);
    await redis.set(featureFlagsKey(), serialized, { ex: CACHE_TTL.FEATURE_FLAGS });

    await this.writeAuditLog(adminId, 'admin_update_feature_flag', 'FeatureFlag', flag, {
      before: existing[flag],
      after: enabled,
    });

    logger.info({ type: 'admin_feature_flag_updated', adminId, flag, enabled });
    return updated;
  }

  async getMaintenanceMode(): Promise<MaintenanceStatus> {
    const cached = await redis.get<string>(maintenanceKey());
    if (cached) return JSON.parse(cached) as MaintenanceStatus;

    return { enabled: false, message: '', startedAt: null };
  }

  async setMaintenanceMode(
    adminId: string,
    enabled: boolean,
    message?: string
  ): Promise<MaintenanceStatus> {
    const status: MaintenanceStatus = {
      enabled,
      message: message ?? DEFAULT_SYSTEM_CONFIG.maintenanceMessage,
      startedAt: enabled ? new Date() : null,
    };

    await redis.set(maintenanceKey(), JSON.stringify(status), { ex: 86400 });
    await updateSystemConfigSnapshot(
      {
        maintenanceMode: enabled,
        ...(message !== undefined ? { maintenanceMessage: status.message } : {}),
      },
      adminId
    );

    // Also update feature flag
    await this.updateFeatureFlag(adminId, 'maintenanceMode', enabled);

    await this.writeAuditLog(adminId, 'admin_set_maintenance', 'System', 'maintenance', {
      enabled,
      message,
    });

    logger.info({ type: 'admin_maintenance_mode_changed', adminId, enabled });
    return status;
  }

  // ==========================================================================
  // PLATFORM MONITORING
  // ==========================================================================

  async getSystemHealth(): Promise<SystemHealth> {
    const health: SystemHealth = {
      status: 'healthy',
      services: {
        database: { status: 'healthy' as 'healthy' | 'degraded' | 'down' },
        redis: { status: 'healthy' as 'healthy' | 'degraded' | 'down' },
        pinecone: { status: 'healthy' as 'healthy' | 'degraded' | 'down' },
        storage: { status: 'healthy' as 'healthy' | 'degraded' | 'down' },
      },
      uptime: process.uptime(),
      version: process.env.npm_package_version ?? '1.0.0',
      checkedAt: new Date(),
    };

    // Database
    try {
      const t = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      health.services.database = { status: 'healthy', latencyMs: Date.now() - t };
    } catch (err: unknown) {
      health.services.database = { status: 'down', message: (err as Error).message };
      health.status = 'degraded';
    }

    // Redis
    try {
      const t = Date.now();
      await redis.ping();
      health.services.redis = { status: 'healthy', latencyMs: Date.now() - t };
    } catch (err: unknown) {
      health.services.redis = { status: 'down', message: (err as Error).message };
      health.status = 'degraded';
    }

    // Pinecone / vector DB
    try {
      const t = Date.now();
      await getIndexStats();
      health.services.pinecone = { status: 'healthy', latencyMs: Date.now() - t };
    } catch (err: unknown) {
      health.services.pinecone = { status: 'down', message: (err as Error).message };
    }

    // R2 / storage
    const storageHealth = await storageService.healthCheck();
    health.services.storage = storageHealth;

    const serviceStatuses = Object.values(health.services).map((service) => service.status);
    if (
      health.services.database.status === 'down' &&
      health.services.redis.status === 'down'
    ) {
      health.status = 'down';
    } else if (serviceStatuses.some((status) => status === 'down' || status === 'degraded')) {
      health.status = 'degraded';
    }

    return health;
  }

  async getOperationalOverview(): Promise<AdminOperationalOverview> {
    const now = new Date();
    const last24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last48Hours = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const last7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const last30Days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const openTicketStatuses = ['OPEN', 'IN_PROGRESS', 'AWAITING_USER'] as const;

    const healthPromise = this.getSystemHealth().catch((error: unknown) => {
      logger.warn({
        type: 'admin_operational_overview_health_failed',
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });

    const [
      totalUsers,
      activeToday,
      activeLast7Days,
      newLast7Days,
      totalQueries,
      queriesLast24Hours,
      queriesLast7Days,
      failedQueryRows,
      failedRunRows,
      feedbackGroups,
      corpusPending,
      corpusOpen,
      corpusResolvedLast7Days,
      supportOpen,
      supportUrgent,
      supportOverdueOrStale,
      failedPaymentsLast30Days,
      revenueLast30Days,
      activeSubscriptions,
      trialUsers,
      failedLoginsLast24Hours,
      suspiciousLoginGroups,
      recentRoleChanges,
      recentLogs,
      health,
    ] = await Promise.all([
      prisma.user.count({ where: { deletedAt: null } }),
      prisma.user.count({ where: { deletedAt: null, lastLoginAt: { gte: last24Hours } } }),
      prisma.user.count({ where: { deletedAt: null, lastLoginAt: { gte: last7Days } } }),
      prisma.user.count({ where: { deletedAt: null, createdAt: { gte: last7Days } } }),
      prisma.complianceQuery.count(),
      prisma.complianceQuery.count({ where: { createdAt: { gte: last24Hours } } }),
      prisma.complianceQuery.count({ where: { createdAt: { gte: last7Days } } }),
      prisma.complianceQuery.findMany({
        where: { createdAt: { gte: last7Days }, status: { in: FAILED_QUERY_STATUSES } },
        select: { id: true },
      }),
      prisma.complianceQueryRun.findMany({
        where: {
          createdAt: { gte: last7Days },
          OR: [
            { status: { in: FAILED_QUERY_STATUSES } },
            { errorMessage: { not: null } },
            { graderFailed: true },
          ],
        },
        select: { complianceQueryId: true },
        distinct: ['complianceQueryId'],
      }),
      prisma.queryFeedback.groupBy({
        by: ['rating'],
        where: { createdAt: { gte: last30Days } },
        _count: { _all: true },
      }),
      prisma.corpusGapReport.count({ where: { status: 'PENDING' } }),
      prisma.corpusGapReport.count({ where: { status: { in: ['PENDING', 'UNDER_REVIEW'] } } }),
      prisma.corpusGapReport.count({ where: { resolvedAt: { gte: last7Days } } }),
      prisma.supportTicket.count({ where: { status: { in: [...openTicketStatuses] } } }),
      prisma.supportTicket.count({ where: { status: { in: [...openTicketStatuses] }, priority: 'URGENT' } }),
      prisma.supportTicket.count({ where: { status: { in: [...openTicketStatuses] }, updatedAt: { lt: last48Hours } } }),
      prisma.payment.count({ where: { status: 'FAILED', createdAt: { gte: last30Days } } }),
      prisma.payment.aggregate({
        where: { status: 'COMPLETED', paidAt: { gte: last30Days } },
        _sum: { amount: true },
      }),
      prisma.organization.count({ where: { subscriptionStatus: 'ACTIVE' } }),
      prisma.organization.count({ where: { subscriptionStatus: 'TRIALING' } }),
      prisma.loginHistory.count({ where: { success: false, createdAt: { gte: last24Hours } } }),
      prisma.loginHistory.groupBy({
        by: ['ipAddress'],
        where: { success: false, createdAt: { gte: last24Hours }, ipAddress: { not: null } },
        _count: { _all: true },
      }),
      prisma.auditLog.count({ where: { action: { in: ROLE_CHANGE_ACTIONS }, createdAt: { gte: last7Days } } }),
      prisma.auditLog.findMany({
        take: 8,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          createdAt: true,
        },
      }),
      healthPromise,
    ]);

    const failedQueryIds = new Set<string>([
      ...failedQueryRows.map((row) => row.id),
      ...failedRunRows.map((row) => row.complianceQueryId),
    ]);
    const failedLast7Days = failedQueryIds.size;
    const upVotesLast30Days = feedbackGroups.find((item) => item.rating === 'up')?._count._all ?? 0;
    const downVotesLast30Days = feedbackGroups.find((item) => item.rating === 'down')?._count._all ?? 0;
    const totalVotesLast30Days = upVotesLast30Days + downVotesLast30Days;
    const suspiciousLoginEvents = suspiciousLoginGroups.filter((item) => item._count._all >= 3).length;

    return {
      users: {
        total: totalUsers,
        activeToday,
        activeLast7Days,
        newLast7Days,
      },
      queries: {
        total: totalQueries,
        last24Hours: queriesLast24Hours,
        last7Days: queriesLast7Days,
        failedLast7Days,
        failureRateLast7Days: queriesLast7Days > 0 ? Math.round((failedLast7Days / queriesLast7Days) * 1000) / 10 : 0,
      },
      feedback: {
        totalVotesLast30Days,
        upVotesLast30Days,
        downVotesLast30Days,
        satisfactionRate: totalVotesLast30Days > 0 ? Math.round((upVotesLast30Days / totalVotesLast30Days) * 1000) / 10 : 0,
      },
      corpusGaps: {
        pending: corpusPending,
        open: corpusOpen,
        resolvedLast7Days: corpusResolvedLast7Days,
      },
      support: {
        open: supportOpen,
        urgent: supportUrgent,
        overdueOrStale: supportOverdueOrStale,
      },
      billing: {
        failedPaymentsLast30Days,
        recentRevenueLast30Days: roundCurrency(toKES(revenueLast30Days._sum.amount)),
        activeSubscriptions,
        trialUsers,
      },
      security: {
        failedLoginsLast24Hours,
        suspiciousLoginEvents,
        recentRoleChanges,
      },
      system: {
        overallStatus: normalizeOperationalStatus(health?.status),
        database: normalizeOperationalStatus(health?.services.database.status),
        redis: normalizeOperationalStatus(health?.services.redis.status),
        storage: normalizeOperationalStatus(health?.services.storage.status),
        pinecone: normalizeOperationalStatus(health?.services.pinecone.status),
      },
      recentActivity: recentLogs.map((log) => ({
        id: log.id,
        type: log.entityType ?? 'System',
        title: toActivityTitle(log.action),
        description: log.entityId ? `${log.entityType ?? 'Entity'} ${log.entityId.slice(0, 8)}` : undefined,
        severity: operationalSeverityForAction(log.action),
        createdAt: log.createdAt.toISOString(),
      })),
    };
  }

  async getDatabaseStats(): Promise<DatabaseStats> {
    const [totalUsers, totalOrgs, totalPolicies, totalDocs, totalLogs] = await Promise.all([
      prisma.user.count(),
      prisma.organization.count(),
      prisma.policy.count(),
      prisma.legalDocument.count({ where: { deletedAt: null } }),
      prisma.auditLog.count(),
    ]);

    return {
      totalUsers,
      totalOrganizations: totalOrgs,
      totalPolicies,
      totalDocuments: totalDocs,
      totalAuditLogs: totalLogs,
    };
  }

  async getCacheStats(): Promise<CacheStats> {
    try {
      // redis.info() is not available on Upstash (HTTP-based managed service)
      await redis.ping();
      const keyCount = await redis.dbsize();

      return {
        memoryUsedMB: 0, // Not available via Upstash REST API
        totalKeys: keyCount,
        status: 'healthy',
      };
    } catch {
      return { memoryUsedMB: 0, totalKeys: 0, status: 'down' };
    }
  }

  async getVectorDBStats(): Promise<VectorDBStats> {
    try {
      const stats = await getIndexStats() as {
        totalRecordCount?: number;
        dimension?: number;
        namespaces?: Record<string, { recordCount?: number }>;
      };
      const vectorCount = stats.totalRecordCount
        ?? Object.values(stats.namespaces ?? {}).reduce((sum, namespace) => sum + (namespace.recordCount ?? 0), 0);

      return {
        indexName: process.env.PINECONE_INDEX_NAME ?? 'sheriabot-legal-docs',
        vectorCount,
        dimensionality: stats.dimension ?? 1536,
        status: 'healthy',
      };
    } catch (error: unknown) {
      logger.warn({
        type: 'admin_vector_db_stats_failed',
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        indexName: process.env.PINECONE_INDEX_NAME ?? 'sheriabot-legal-docs',
        vectorCount: 0,
        dimensionality: 1536,
        status: 'down',
      };
    }
  }

  async getStorageStats(): Promise<StorageStats> {
    const [docs, health] = await Promise.all([
      prisma.legalDocument.findMany({
        where: { deletedAt: null },
        select: { fileSize: true },
      }),
      storageService.healthCheck(),
    ]);

    const totalSizeMB = Math.round(
      docs.reduce((sum, d) => sum + d.fileSize, 0) / (1024 * 1024)
    );

    return {
      totalFiles: docs.length,
      totalSizeMB,
      status: health.status,
    };
  }

  async getActiveConnections(): Promise<ConnectionStats> {
    const activeSessions = await prisma.session.count({
      where: { expiresAt: { gte: new Date() } },
    });

    return {
      activeDatabaseConnections: 1,
      activeRedisConnections: 1,
      activeSessions,
    };
  }

  async getErrorLog(_filters: ErrorLogFilters): Promise<PaginatedErrorLog> {
    // Error logs would typically come from a dedicated logging service or table.
    // For now, surface FAILED documents and policies as error indicators.
    return { items: [], total: 0, page: 1, limit: 20 };
  }

  async getAuditLog(filters: AuditLogFilters): Promise<PaginatedAuditLog> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 50;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {
      ...(filters.userId && { userId: filters.userId }),
      ...(filters.entityType && { entityType: filters.entityType }),
      ...(filters.entityId && { entityId: filters.entityId }),
      ...(filters.action && { action: { contains: filters.action } }),
      ...(filters.actorEmail && { user: { email: { contains: filters.actorEmail, mode: 'insensitive' } } }),
      ...(filters.dateFrom || filters.dateTo
        ? {
            createdAt: {
              ...(filters.dateFrom && { gte: filters.dateFrom }),
              ...(filters.dateTo && { lte: filters.dateTo }),
            },
          }
        : {}),
    };

    const andConditions = [];
    if (filters.organizationId) {
      andConditions.push({
        OR: [
          { entityType: 'Organization', entityId: filters.organizationId },
          { user: { organizationId: filters.organizationId } }
        ]
      });
    }
    if (filters.search) {
      andConditions.push({
        OR: [
          { action: { contains: filters.search, mode: 'insensitive' } },
          { entityId: { contains: filters.search, mode: 'insensitive' } },
          { user: { email: { contains: filters.search, mode: 'insensitive' } } },
          { user: { fullName: { contains: filters.search, mode: 'insensitive' } } },
        ]
      });
    }

    if (andConditions.length > 0) {
      where.AND = andConditions;
    }

    let items: AuditLogEntry[];
    let total: number;

    if (filters.severity) {
      // Memory pagination: fetch candidate logs and filter by derived severity.
      // Note: Pagination limited to first 2000 candidate records.
      const candidateLogs = await prisma.auditLog.findMany({
        where: where as any,
        include: { user: { include: { organization: true } } },
        orderBy: { createdAt: 'desc' },
        take: 2000,
      });
      const mapped = candidateLogs.map((l) => toAuditLogEntry(l as unknown as Record<string, unknown>));
      const filtered = mapped.filter((l) => l.severity === filters.severity);
      total = filtered.length;
      items = filtered.slice(skip, skip + limit);
    } else {
      // Standard DB pagination
      const [dbLogs, dbTotal] = await Promise.all([
        prisma.auditLog.findMany({
          where: where as any,
          include: { user: { include: { organization: true } } },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
        prisma.auditLog.count({
          where: where as any,
        }),
      ]);
      items = dbLogs.map((l) => toAuditLogEntry(l as unknown as Record<string, unknown>));
      total = dbTotal;
    }

    return {
      items,
      nextCursor: items.length === limit ? String(page + 1) : null,
      total,
      page,
      limit,
    };
  }

  async getAuditLogDetail(id: string): Promise<AuditLogEntry> {
    const log = await prisma.auditLog.findUnique({
      where: { id },
      include: { user: { include: { organization: true } } },
    });
    
    if (!log) {
      throw new NotFoundError('Audit log entry not found');
    }

    return toAuditLogEntry(log as unknown as Record<string, unknown>);
  }

  // ==========================================================================
  // REGULATORY FRAMEWORK MANAGEMENT
  // ==========================================================================

  async getRegulatoryFrameworks(): Promise<RegulatoryFramework[]> {
    const cached = await redis.get<string>(frameworksKey());
    if (cached) return JSON.parse(cached) as RegulatoryFramework[];

    // Frameworks stored in Redis (lightweight  -  no dedicated DB table needed)
    return [];
  }

  async createRegulatoryFramework(
    adminId: string,
    params: FrameworkParams
  ): Promise<RegulatoryFramework> {
    const framework: RegulatoryFramework = {
      id: nanoid(16),
      name: params.name,
      description: params.description,
      area: params.area,
      country: params.country ?? 'Kenya',
      effectiveDate: params.effectiveDate ?? null,
      status: params.status ?? 'active',
      documentIds: params.documentIds ?? [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const existing = await this.getRegulatoryFrameworks();
    const updated = [...existing, framework];
    await redis.set(frameworksKey(), JSON.stringify(updated));

    await this.writeAuditLog(adminId, 'admin_create_framework', 'RegulatoryFramework', framework.id, {
      name: params.name,
    });

    return framework;
  }

  async updateRegulatoryFramework(
    adminId: string,
    frameworkId: string,
    params: Partial<FrameworkParams>
  ): Promise<RegulatoryFramework> {
    const frameworks = await this.getRegulatoryFrameworks();
    const idx = frameworks.findIndex((f) => f.id === frameworkId);
    if (idx === -1) throw new NotFoundError('Regulatory framework');

    const updated = {
      ...frameworks[idx],
      ...params,
      updatedAt: new Date(),
    };
    frameworks[idx] = updated;
    await redis.set(frameworksKey(), JSON.stringify(frameworks));

    await this.writeAuditLog(adminId, 'admin_update_framework', 'RegulatoryFramework', frameworkId, params);
    return updated;
  }

  async deleteRegulatoryFramework(adminId: string, frameworkId: string): Promise<void> {
    const frameworks = await this.getRegulatoryFrameworks();
    const filtered = frameworks.filter((f) => f.id !== frameworkId);
    if (filtered.length === frameworks.length) throw new NotFoundError('Regulatory framework');

    await redis.set(frameworksKey(), JSON.stringify(filtered));
    await this.writeAuditLog(adminId, 'admin_delete_framework', 'RegulatoryFramework', frameworkId, {});
  }

  // ==========================================================================
  // INVITATIONS & ONBOARDING
  // ==========================================================================

  async getPendingInvitations(): Promise<PendingInvitation[]> {
    // Invitations indexed in a tracking set by OrganizationModule on each invite creation.
    // Key format: org:invitation:{token} (matches ORGANIZATION_CONSTANTS.REDIS_KEYS.INVITATION).
    const inviteKeys = await redis.smembers<string[]>('sheriabot:idx:invitations');
    const invites: PendingInvitation[] = [];

    for (const key of inviteKeys.slice(0, 100)) {
      const raw = await redis.get<string>(key);
      if (!raw) continue;
      try {
        const invite = JSON.parse(raw) as Record<string, unknown>;
        invites.push({
          id: invite.id as string,
          email: invite.email as string,
          organizationId: invite.organizationId as string,
          organizationName: (invite.organizationName as string) ?? '',
          role: invite.role as string,
          invitedBy: (invite.invitedBy as string) ?? '',
          expiresAt: new Date(invite.expiresAt as string),
          createdAt: new Date(invite.createdAt as string),
        });
      } catch { /* Skip malformed */ }
    }

    return invites.filter((i) => i.expiresAt > new Date());
  }

  async resendInvitation(adminId: string, invitationId: string): Promise<void> {
    logger.info({ type: 'admin_resend_invitation', adminId, invitationId });
    // The OrganizationModule handles resend  -  proxy call here if needed
  }

  async revokeInvitation(adminId: string, invitationId: string): Promise<void> {
    const inviteKey = `org:invitation:${invitationId}`;
    await redis.del(inviteKey);
    await redis.srem('sheriabot:idx:invitations', inviteKey);
    await this.writeAuditLog(adminId, 'admin_revoke_invitation', 'Invitation', invitationId, {});
  }

  // ==========================================================================
  // SUBSCRIPTION & BILLING
  // ==========================================================================

  async getSubscriptionOverview(): Promise<SubscriptionOverview> {
    const orgs = await prisma.organization.findMany({
      select: { plan: true, subscriptionStatus: true },
    });

    const byPlan = Object.fromEntries(
      SUBSCRIPTION_PLANS.map((plan) => [plan, 0])
    ) as Record<SubscriptionPlan, number>;

    for (const org of orgs) {
      const plan = org.plan as SubscriptionPlan;
      if (plan in byPlan) byPlan[plan]++;
    }

    const total = orgs.length;
    const active = orgs.filter((o) => o.subscriptionStatus === 'ACTIVE').length;
    const trials = orgs.filter((o) => o.subscriptionStatus === 'TRIALING').length;
    const converted = orgs.filter(
      (o) => o.subscriptionStatus === 'ACTIVE' && o.plan !== PrismaSubscriptionPlan.REGULATOR
    ).length;
    const churned = orgs.filter(
      (o) => o.subscriptionStatus === 'CANCELLED' || o.subscriptionStatus === 'EXPIRED'
    ).length;

    return {
      totalActive: active,
      byPlan,
      trialConversionRate:
        converted + trials > 0 ? Math.round((converted / (converted + trials)) * 100) : 0,
      churnRate: total > 0 ? Math.round((churned / total) * 100) : 0,
    };
  }

  async getBillingPlanCatalog(): Promise<BillingPlanCatalog> {
    return loadBillingPlanCatalog();
  }

  async updateBillingPlanCatalog(
    adminId: string,
    input: BillingPlanCatalogUpdateInput
  ): Promise<BillingPlanCatalog> {
    // Defence-in-depth validation. The router Zod schema enforces structure and ranges;
    // these checks enforce business rules that Zod cannot express.
    const STRIPE_PRICE_ID_RE = /^price_[a-zA-Z0-9_]+$/;
    for (const plan of input.plans) {
      if (plan.price.monthly !== null && plan.price.monthly <= 0) {
        throw new BadRequestError(`Plan ${plan.id}: monthly price must be greater than zero.`);
      }
      if (plan.price.yearly !== null && plan.price.yearly !== undefined && plan.price.yearly <= 0) {
        throw new BadRequestError(`Plan ${plan.id}: yearly price must be greater than zero.`);
      }
      if (plan.stripe.monthlyPriceId && !STRIPE_PRICE_ID_RE.test(plan.stripe.monthlyPriceId)) {
        throw new BadRequestError(`Plan ${plan.id}: invalid Stripe price ID format: ${plan.stripe.monthlyPriceId}`);
      }
      if (plan.stripe.yearlyPriceId && !STRIPE_PRICE_ID_RE.test(plan.stripe.yearlyPriceId)) {
        throw new BadRequestError(`Plan ${plan.id}: invalid Stripe price ID format: ${plan.stripe.yearlyPriceId}`);
      }
    }

    const catalog = await persistBillingPlanCatalog(input, adminId);

    await this.writeAuditLog(adminId, 'admin_update_billing_plan_catalog', 'System', 'billing-plan-catalog', {
      plans: input.plans,
    });

    logger.info({
      type: 'admin_billing_plan_catalog_updated',
      adminId,
      planIds: input.plans.map((plan) => plan.id),
    });

    return catalog;
  }

  async updateUserSubscription(
    adminId: string,
    userId: string,
    plan: SubscriptionPlan
  ): Promise<Subscription> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { organizationId: true },
    });
    if (!user) throw new NotFoundError('User');
    if (!user.organizationId) throw new BadRequestError('User is not part of an organization');

    const orgId     = user.organizationId;
    const prismaplan = PrismaSubscriptionPlan[plan as keyof typeof PrismaSubscriptionPlan];

    const oldOrg = await prisma.organization.findUnique({
      where:  { id: orgId },
      select: { plan: true },
    });

    await prisma.organization.update({
      where: { id: orgId },
      data: {
        subscriptionTier: plan,        // legacy field  -  keep in sync
        plan:             prismaplan,  // authoritative field read by withPlanContext
        subscriptionStatus: SubscriptionStatus.ACTIVE,
      },
    });

    logger.info({
      type:             'plan_sync',
      orgId,
      oldPlan:          oldOrg?.plan ?? null,
      newPlan:          prismaplan,
      subscriptionTier: plan,
      source:           'admin_update_user_subscription',
    });

    await this.invalidatePlanCacheForOrg(orgId, 'admin_update_user_subscription');
    await this.invalidateOrganizationStatsCache();

    await this.writeAuditLog(adminId, 'admin_update_subscription', 'Organization', orgId, {
      plan,
      prismaplan,
    });

    return {
      userId,
      organizationId: orgId,
      plan,
      status: 'active',
      updatedAt: new Date(),
    };
  }

  // ==========================================================================
  // USER CREATION (ADMIN-INITIATED)
  // ==========================================================================

  async createUser(adminId: string, input: CreateUserInput, requestId: string): Promise<AdminUserDetail> {
    // Check for existing user
    const existing = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    if (existing) throw new BadRequestError('A user with this email already exists');

    // Create in Supabase Auth
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: input.email.toLowerCase(),
      password: input.password,
      email_confirm: true,
    });

    if (authError || !authData.user) {
      throw new BadRequestError(authError?.message ?? 'Failed to create user in auth provider');
    }

    const supabaseAuthId = authData.user.id;

    const { user } = await createUserWithOrganization({
      email: input.email,
      fullName: input.fullName,
      role: input.role,
      subscriptionTier: input.subscriptionTier,
      isPilot: input.isPilot ?? false,
      organizationId: input.organizationId,
      organizationName: input.organizationName,
      supabaseAuthId,
      adminId,
      requestId,
    });

    logger.info({ type: 'admin_user_created', adminId, userId: user.id, role: user.role });

    // -- Send welcome email via Resend (fire-and-forget  -  never blocks user creation) --
    if (input.sendWelcomeEmail) {
      const dashboardUrl = appConfig.frontendUrl;
      const isPilot = input.isPilot ?? false;

      try {
        if (isPilot) {
          // Pilot users get the PilotWelcomeEmail with login instructions and feature highlights
          const pilotExpiresAt = (user as any).pilotExpiresAt
            ? (user as any).pilotExpiresAt.toISOString()
            : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

          await reactMailer.sendPilotWelcomeEmail(input.email.toLowerCase(), {
            userName: input.fullName,
            organization: user.organization?.name ?? input.organizationName ?? '',
            pilotExpiresAt,
            dashboardUrl,
          });

          logger.info({
            type: 'pilot_welcome_email_sent',
            userId: user.id,
            email: input.email,
            requestId,
          });
        } else {
          // Non-pilot users get the standard WelcomeEmail
          await reactMailer.sendWelcomeEmail(input.email.toLowerCase(), {
            userName: input.fullName,
            role: input.role,
            organizationName: user.organization?.name ?? input.organizationName,
            dashboardUrl,
          });

          logger.info({
            type: 'welcome_email_sent',
            userId: user.id,
            email: input.email,
            requestId,
          });
        }
      } catch (emailErr: unknown) {
        // Email failures must never crash user creation  -  log and continue
        const errorMessage = emailErr instanceof Error ? emailErr.message : String(emailErr);
        logger.error({
          type: 'admin_create_user_welcome_email_failed',
          userId: user.id,
          email: input.email,
          isPilot,
          error: errorMessage,
          requestId,
        });
      }
    }

    return toAdminUserDetail(user as unknown as Record<string, unknown>, {
      sessions: 0,
      policies: 0,
      queries: 0,
    });
  }

  // ==========================================================================
  // ORGANIZATION UPDATE
  // ==========================================================================

  async updateOrganization(
    adminId: string,
    orgId: string,
    input: UpdateOrganizationInput
  ): Promise<AdminOrgDetail> {
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new NotFoundError('Organization');

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const key of Object.keys(input) as (keyof UpdateOrganizationInput)[]) {
      if (input[key] !== undefined) {
        before[key] = (org as Record<string, unknown>)[key];
        after[key] = input[key];
      }
    }

    await prisma.organization.update({
      where: { id: orgId },
      data: input as never,
    });

    await this.writeAuditLog(adminId, 'admin_update_org', 'Organization', orgId, { before, after });
    logger.info({ type: 'admin_org_updated', adminId, orgId, fields: Object.keys(input) });
    await this.invalidateOrganizationStatsCache();

    return this.getOrganizationDetails(orgId);
  }

  // ==========================================================================
  // ANALYTICS
  // ==========================================================================

  async getUserGrowth(
    period: 'daily' | 'weekly' | 'monthly',
    dateFrom: Date,
    dateTo: Date
  ): Promise<UserGrowthData> {
    // Validate dates at module boundary
    if (isNaN(dateFrom.getTime()) || isNaN(dateTo.getTime())) {
      throw new BadRequestError('Invalid date range: dateFrom and dateTo must be valid Date objects');
    }
    if (dateFrom > dateTo) {
      throw new BadRequestError('dateFrom cannot be after dateTo');
    }

    const emptyResult: UserGrowthData = {
      series: [],
      total: 0,
      periodStart: dateFrom.toISOString(),
      periodEnd: dateTo.toISOString(),
    };

    try {
      // Fetch only active (non-deleted) users created within the date range.
      // The Prisma client extension automatically filters deletedAt: null on user.findMany.
      const users = await prisma.user.findMany({
        where: { createdAt: { gte: dateFrom, lte: dateTo } },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      });

      // Group by period bucket
      const buckets = new Map<string, number>();

      for (const user of users) {
        if (!user.createdAt) continue;

        const d = user.createdAt;
        let key: string;
        if (period === 'daily') {
          key = formatBucketKey(d, 'daily');
        } else if (period === 'weekly') {
          key = formatBucketKey(startOfUtcWeek(d), 'weekly');
        } else {
          key = formatBucketKey(d, 'monthly');
        }
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
      }

      const series = buildCountSeries(period, dateFrom, dateTo, buckets);

      return {
        series,
        total: users.length,
        periodStart: dateFrom.toISOString(),
        periodEnd: dateTo.toISOString(),
      };
    } catch (error: any) {
      logger.error({
        type: 'admin_get_user_growth_error',
        period,
        dateFrom: dateFrom.toISOString(),
        dateTo: dateTo.toISOString(),
        error: { name: error.name, message: error.message, code: error.code },
      });

      // Return safe empty result instead of propagating raw Prisma errors
      return emptyResult;
    }
  }

  async getRevenueMetrics(dateFrom: Date, dateTo: Date): Promise<RevenueMetrics> {
    // validate dates at module boundary
    if (isNaN(dateFrom.getTime()) || isNaN(dateTo.getTime())) {
      throw new BadRequestError('Invalid date range: dateFrom and dateTo must be valid Date objects');
    }
    if (dateFrom > dateTo) {
      throw new BadRequestError('dateFrom cannot be after dateTo');
    }

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    const [allPayments, thisMonthPayments, lastMonthPayments] = await Promise.all([
      prisma.payment.findMany({
        where: { status: 'COMPLETED', paidAt: { gte: dateFrom, lte: dateTo } },
        select: { amount: true, provider: true, paidAt: true },
      }),
      prisma.payment.aggregate({
        where: { status: 'COMPLETED', paidAt: { gte: monthStart } },
        _sum: { amount: true },
      }),
      prisma.payment.aggregate({
        where: { status: 'COMPLETED', paidAt: { gte: lastMonthStart, lte: lastMonthEnd } },
        _sum: { amount: true },
      }),
    ]);

    const totalAll = await prisma.payment.aggregate({
      where: { status: 'COMPLETED' },
      _sum: { amount: true },
    });

    const successCount = await prisma.payment.count({ where: { status: 'COMPLETED', paidAt: { gte: dateFrom, lte: dateTo } } });
    const totalCount = await prisma.payment.count({ where: { paidAt: { gte: dateFrom, lte: dateTo } } });

    // Monthly series
    const monthlyBuckets = new Map<string, number>();
    for (const p of allPayments) {
      if (!p.paidAt) continue;
      const key = p.paidAt.toISOString().slice(0, 7);
      monthlyBuckets.set(key, (monthlyBuckets.get(key) ?? 0) + toKES(p.amount));
    }

    const byProvider = { STRIPE: 0, MPESA: 0 };
    for (const p of allPayments) {
      if (p.provider === 'STRIPE') byProvider.STRIPE += toKES(p.amount);
      else if (p.provider === 'MPESA') byProvider.MPESA += toKES(p.amount);
    }

    return {
      totalRevenue: roundCurrency(toKES(totalAll._sum.amount)),
      currentMonthRevenue: roundCurrency(toKES(thisMonthPayments._sum.amount)),
      lastMonthRevenue: roundCurrency(toKES(lastMonthPayments._sum.amount)),
      series: buildAmountSeries(dateFrom, dateTo, monthlyBuckets),
      byProvider: {
        STRIPE: roundCurrency(byProvider.STRIPE),
        MPESA: roundCurrency(byProvider.MPESA),
      },
      successRate: totalCount > 0 ? Math.round((successCount / totalCount) * 100) : 100,
    };
  }

  async getAIUsageMetrics(dateFrom: Date, dateTo: Date): Promise<AIUsageMetrics> {
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

    const [totalQueries, totalPolicies, totalChecklists, totalGapAnalyses,
           queriesThisMonth, policiesThisMonth] = await Promise.all([
      prisma.complianceQuery.count({ where: { createdAt: { gte: dateFrom, lte: dateTo } } }),
      prisma.policy.count({ where: { status: 'COMPLETED', createdAt: { gte: dateFrom, lte: dateTo } } }),
      prisma.checklist.count({ where: { status: 'COMPLETED', createdAt: { gte: dateFrom, lte: dateTo } } }),
      prisma.gapAnalysis.count({ where: { status: 'COMPLETED', createdAt: { gte: dateFrom, lte: dateTo } } }),
      prisma.complianceQuery.count({ where: { createdAt: { gte: monthStart } } }),
      prisma.policy.count({ where: { status: 'COMPLETED', createdAt: { gte: monthStart } } }),
    ]);

    // Daily query series
    const dailyQueries = await prisma.complianceQuery.findMany({
      where: { createdAt: { gte: dateFrom, lte: dateTo } },
      select: { createdAt: true },
    });

    const buckets = new Map<string, number>();
    for (const q of dailyQueries) {
      // Defensive null check
      if (!q.createdAt) continue;

      const key = formatBucketKey(q.createdAt, 'daily');
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }

    return {
      totalQueries,
      totalPolicies,
      totalChecklists,
      totalGapAnalyses,
      queriesThisMonth,
      policiesThisMonth,
      series: buildCountSeries('daily', dateFrom, dateTo, buckets),
    };
  }

  /**
   * Returns the most recent payments across all orgs.
   * Amounts are normalized to major units (KES) via toKES().
   */
  async getRecentPayments(limit: number): Promise<PaymentSummary[]> {
    const payments = await prisma.payment.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { org: { select: { name: true } } },
    });

    return payments.map((p) => ({
      id: p.id,
      orgId: p.orgId,
      orgName: p.org.name,
      provider: String(p.provider),
      amount: toKES(p.amount),
      currency: p.currency,
      status: String(p.status),
      invoiceNumber: p.invoiceNumber ?? null,
      subscriptionPlan: p.subscriptionPlan ?? null,
      paidAt: p.paidAt ?? null,
      createdAt: p.createdAt,
    }));
  }

  /**
   * Returns payment history for a single organization, paginated.
   * Amounts are normalized to major units (KES) via toKES().
   */
  async getOrgPaymentHistory(
    orgId: string,
    page: number,
    limit: number,
  ): Promise<OrgPaymentHistory> {
    const skip = (page - 1) * limit;
    const where = { orgId };

    const [rawItems, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { org: { select: { name: true } } },
      }),
      prisma.payment.count({ where }),
    ]);

    const items: PaymentSummary[] = rawItems.map((p) => ({
      id: p.id,
      orgId: p.orgId,
      orgName: p.org.name,
      provider: String(p.provider),
      amount: toKES(p.amount),
      currency: p.currency,
      status: String(p.status),
      invoiceNumber: p.invoiceNumber ?? null,
      subscriptionPlan: p.subscriptionPlan ?? null,
      paidAt: p.paidAt ?? null,
      createdAt: p.createdAt,
    }));

    return { items, total, page, limit };
  }

  /**
   * Subscription plan/status breakdown across all organizations.
   * Optional dateFrom/dateTo filters to cohort by org creation date.
   */
  async getSubscriptionBreakdown(filters?: { dateFrom?: Date; dateTo?: Date }): Promise<SubscriptionBreakdown> {
    const where: Record<string, unknown> = {};
    if (filters?.dateFrom || filters?.dateTo) {
      where.createdAt = {
        ...(filters.dateFrom && { gte: filters.dateFrom }),
        ...(filters.dateTo && { lte: filters.dateTo }),
      };
    }

    const orgs = await prisma.organization.findMany({
      where: where as never,
      select: { plan: true, subscriptionStatus: true },
    });

    const byPlan: Record<string, number> = Object.fromEntries(
      SUBSCRIPTION_PLANS.map((plan) => [plan, 0])
    );
    const byStatus: Record<string, number> = {};

    for (const org of orgs) {
      const plan = String(org.plan);
      const status = String(org.subscriptionStatus);
      byPlan[plan] = (byPlan[plan] ?? 0) + 1;
      byStatus[status] = (byStatus[status] ?? 0) + 1;
    }

    return { byPlan, byStatus, total: orgs.length };
  }

  // ==========================================================================
  // LOGIN HISTORY
  // ==========================================================================

  async recordLoginHistory(entry: Omit<LoginHistoryEntry, 'id' | 'createdAt'>): Promise<void> {
    try {
      await prisma.loginHistory.create({ data: entry });
    } catch (err: unknown) {
      logger.warn({ type: 'login_history_write_failed', error: (err as Error).message });
    }
  }

  async getLoginHistory(filters: LoginHistoryFilters): Promise<PaginatedLoginHistory> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 50;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {
      ...(filters.userId && { userId: filters.userId }),
      ...(filters.email && { email: { contains: filters.email, mode: 'insensitive' } }),
      ...(filters.success !== undefined && { success: filters.success }),
      ...((filters.dateFrom || filters.dateTo) && {
        createdAt: {
          ...(filters.dateFrom && { gte: filters.dateFrom }),
          ...(filters.dateTo && { lte: filters.dateTo }),
        },
      }),
    };

    const [items, total] = await Promise.all([
      prisma.loginHistory.findMany({
        where: where as never,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.loginHistory.count({ where: where as never }),
    ]);

    return { items, total, page, limit };
  }

  // ==========================================================================
  // CONTENT MANAGEMENT (BLOG + KNOWLEDGE BASE)
  // ==========================================================================

  async createContent(
    adminId: string,
    input: { contentType: 'BLOG_POST' | 'KNOWLEDGE_BASE_ARTICLE'; title: string; excerpt?: string; category?: string }
  ): Promise<{ id: string }> {
    const doc = await prisma.legalDocument.create({
      data: {
        actName: input.title,
        documentType: 'CONTENT',
        originalFilename: '',
        fileUrl: '',
        fileSize: 0,
        mimeType: 'text/html',
        contentType: input.contentType as never,
        contentStatus: 'DRAFT' as never,
        title: input.title,
        excerpt: input.excerpt ?? null,
        category: input.category ?? null,
        authorId: adminId,
      },
    });

    await this.writeAuditLog(adminId, 'admin_create_content', 'LegalDocument', doc.id, {
      contentType: input.contentType,
      title: input.title,
    });

    logger.info({ type: 'admin_content_created', adminId, documentId: doc.id, contentType: input.contentType });
    return { id: doc.id };
  }

  async listContent(filters: ContentFilters): Promise<PaginatedContent> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {
      contentType: filters.contentType,
      deletedAt: null,
      ...(filters.contentStatus && { contentStatus: filters.contentStatus }),
      ...(filters.search && {
        OR: [
          { title: { contains: filters.search, mode: 'insensitive' } },
          { excerpt: { contains: filters.search, mode: 'insensitive' } },
        ],
      }),
    };

    const [docs, total] = await Promise.all([
      prisma.legalDocument.findMany({
        where: where as never,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          title: true,
          slug: true,
          excerpt: true,
          contentType: true,
          contentStatus: true,
          category: true,
          viewCount: true,
          publishedAt: true,
          createdAt: true,
          updatedAt: true,
          authorId: true,
        },
      }),
      prisma.legalDocument.count({ where: where as never }),
    ]);

    return {
      items: docs.map((d) => ({
        id: d.id,
        title: d.title,
        slug: d.slug,
        excerpt: d.excerpt,
        contentType: String(d.contentType),
        contentStatus: String(d.contentStatus),
        category: d.category,
        viewCount: d.viewCount,
        publishedAt: d.publishedAt,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        authorId: d.authorId,
      })),
      total,
      page,
      limit,
    };
  }

  async updateContentStatus(
    adminId: string,
    documentId: string,
    contentStatus: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' | 'UNDER_REVIEW'
  ): Promise<ContentItem> {
    const doc = await prisma.legalDocument.findUnique({ where: { id: documentId } });
    if (!doc) throw new NotFoundError('Content item');

    const data: Record<string, unknown> = { contentStatus };
    if (contentStatus === 'PUBLISHED' && !doc.publishedAt) {
      data['publishedAt'] = new Date();
      data['publishedBy'] = adminId;
    }

    const updated = await prisma.legalDocument.update({
      where: { id: documentId },
      data: data as never,
    });

    await this.writeAuditLog(adminId, 'admin_update_content_status', 'LegalDocument', documentId, {
      before: String(doc.contentStatus),
      after: contentStatus,
    });

    return {
      id: updated.id,
      title: updated.title,
      slug: updated.slug,
      excerpt: updated.excerpt,
      contentType: String(updated.contentType),
      contentStatus: String(updated.contentStatus),
      category: updated.category,
      viewCount: updated.viewCount,
      publishedAt: updated.publishedAt,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
      authorId: updated.authorId,
    };
  }

  async deleteContent(adminId: string, documentId: string): Promise<void> {
    const doc = await prisma.legalDocument.findUnique({ where: { id: documentId } });
    if (!doc) throw new NotFoundError('Content item');

    await prisma.legalDocument.update({
      where: { id: documentId },
      data: { deletedAt: new Date() },
    });

    await this.writeAuditLog(adminId, 'admin_delete_content', 'LegalDocument', documentId, {
      title: doc.title,
      contentType: String(doc.contentType),
    });

    logger.info({ type: 'admin_content_deleted', adminId, documentId });
  }

  // ==========================================================================
  // SECURITY  -  SESSION LISTING & SIGN-OUT
  // ==========================================================================

  /**
   * Returns all currently-active (non-expired) sessions for a user.
   * Read-only  -  individual session revocation is not exposed; use
   * signOutUserEverywhere to invalidate all tokens at once.
   */
  async listUserActiveSessions(userId: string): Promise<SessionSummary[]> {
    const sessions = await prisma.session.findMany({
      where: { userId, expiresAt: { gte: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    return sessions.map((s) => ({
      id: s.id,
      userId: s.userId,
      device: s.device ?? null,
      ipAddress: s.ipAddress ?? null,
      userAgent: s.userAgent ?? null,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
    }));
  }

  /**
   * Signs a user out of ALL devices by:
   *   1. Writing a user-level token revocation sentinel in Redis  -  every
   *      in-flight JWT issued before this timestamp will be rejected on its
   *      next request (covers the full 1-hour Supabase token lifetime + margin).
   *   2. Deleting all Session rows for the user so the session list is empty.
   *   3. Writing an audit log entry.
   *
   * This does NOT revoke a single session  -  it revokes every token the user
   * currently holds.  Callers should make this semantics clear in the UI.
   */
  async signOutUserEverywhere(adminId: string, userId: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundError('User');

    // Revoke all live JWTs by setting the user-level revocation timestamp.
    // TTL = 7200s (2 h)  -  safely outlives the 1-hour Supabase access-token lifetime.
    await revokeAllUserTokens(userId, 'admin_revoke');

    // Remove all DB session rows so the admin UI session list reflects the change.
    await prisma.session.deleteMany({ where: { userId } });

    await this.writeAuditLog(adminId, 'admin_sign_out_user_everywhere', 'User', userId, {
      note: 'All user tokens revoked; all session rows deleted.',
    });

    logger.info({ type: 'admin_sign_out_user_everywhere', adminId, userId });
  }

  // ==========================================================================
  // AUDIT LOG EXPORT
  // ==========================================================================

  /** Maximum rows fetched for each export format (hardcoded  -  not configurable). */
  private static readonly AUDIT_LOG_CSV_MAX_ROWS  = 50_000;
  private static readonly AUDIT_LOG_DOCX_MAX_ROWS =  2_000;

  /** 15-minute presigned URL TTL for audit log exports (TD-005). */
  private static readonly AUDIT_LOG_EXPORT_URL_TTL = 900;

  /**
   * Generates a server-side audit log export, uploads it to R2, and returns
   * a 60-minute presigned GET URL.
   *
   * - CSV: up to 10 000 rows; content-type text/csv
   * - DOCX: up to 2 000 rows; content-type application/vnd.openxmlformats-officedocument.wordprocessingml.document
   *
   * The export key is `exports/audit-logs/<nanoid(12)>.<ext>`.
   */
  async exportAuditLogs(
    filters: AuditLogExportFilters,
    format: 'csv' | 'docx',
  ): Promise<{ url: string; expiresAt: Date }> {
    const maxRows = format === 'csv'
      ? AdminModule.AUDIT_LOG_CSV_MAX_ROWS
      : AdminModule.AUDIT_LOG_DOCX_MAX_ROWS;

    const where: Record<string, unknown> = {
      ...(filters.userId && { userId: filters.userId }),
      ...(filters.entityType && { entityType: filters.entityType }),
      ...(filters.entityId && { entityId: filters.entityId }),
      ...(filters.action && { action: { contains: filters.action } }),
      ...(filters.actorEmail && { user: { email: { contains: filters.actorEmail, mode: 'insensitive' } } }),
      ...((filters.dateFrom || filters.dateTo) && {
        createdAt: {
          ...(filters.dateFrom && { gte: filters.dateFrom }),
          ...(filters.dateTo   && { lte: filters.dateTo }),
        },
      }),
    };

    const andConditions = [];
    if (filters.organizationId) {
      andConditions.push({
        OR: [
          { entityType: 'Organization', entityId: filters.organizationId },
          { user: { organizationId: filters.organizationId } }
        ]
      });
    }
    if (filters.search) {
      andConditions.push({
        OR: [
          { action: { contains: filters.search, mode: 'insensitive' } },
          { entityId: { contains: filters.search, mode: 'insensitive' } },
          { user: { email: { contains: filters.search, mode: 'insensitive' } } },
          { user: { fullName: { contains: filters.search, mode: 'insensitive' } } },
        ]
      });
    }

    if (andConditions.length > 0) {
      where.AND = andConditions;
    }

    const rows = await prisma.auditLog.findMany({
      where: where as never,
      include: { user: { include: { organization: true } } },
      orderBy: { createdAt: 'desc' },
      take: maxRows,
    });

    let logs: AuditLogEntry[] = rows.map((l) =>
      toAuditLogEntry(l as unknown as Record<string, unknown>)
    );

    if (filters.severity) {
      logs = logs.filter(l => l.severity === filters.severity);
    }

    const buffer = format === 'csv'
      ? this.buildAuditLogCsv(logs)
      : await this.buildAuditLogDocx(logs);

    const contentType = format === 'csv'
      ? 'text/csv'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    const ext = format;
    const key = `exports/audit-logs/${nanoid(12)}.${ext}`;

    await r2PrivateClient.send(new PutObjectCommand({
      Bucket:      r2PrivateBucket,
      Key:         key,
      Body:        buffer,
      ContentType: contentType,
      Metadata:    { 'generated-by': 'sheriabot-admin', format },
    }));

    const ttl = AdminModule.AUDIT_LOG_EXPORT_URL_TTL;
    const url = await getSignedUrl(
      r2PrivateClient,
      new GetObjectCommand({
        Bucket:                      r2PrivateBucket,
        Key:                         key,
        ResponseContentType:         contentType,
        ResponseContentDisposition:  `attachment; filename="audit-logs.${ext}"`,
      }),
      { expiresIn: ttl },
    );

    const expiresAt = new Date(Date.now() + ttl * 1000);

    logger.info({
      type:    'admin_audit_log_export_generated',
      format,
      rowCount: logs.length,
      key,
      expiresAt,
    });

    return { url, expiresAt };
  }

  async exportAnalyticsCsv(dateFrom: Date, dateTo: Date): Promise<{ url: string; expiresAt: Date }> {
    const [revenue, aiUsage, subBreakdown] = await Promise.all([
      this.getRevenueMetrics(dateFrom, dateTo),
      this.getAIUsageMetrics(dateFrom, dateTo),
      this.getSubscriptionBreakdown(),
    ]);

    const PLAN_DISPLAY: Record<string, string> = {
      REGULATOR: 'Regulator',
      STARTUP:   'Startup',
      BUSINESS:  'Business',
      ENTERPRISE: 'Enterprise',
    };

    const formatStatus = (s: string) =>
      s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

    const esc = (v: string | number): string => {
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };

    const rows: string[] = ['Section,Label,Value'];

    Object.entries(subBreakdown.byPlan).forEach(([plan, count]) => {
      rows.push([esc('Plan breakdown'), esc(PLAN_DISPLAY[plan] ?? plan), count].join(','));
    });
    Object.entries(subBreakdown.byStatus).forEach(([status, count]) => {
      rows.push([esc('Status breakdown'), esc(formatStatus(status)), count].join(','));
    });
    rows.push([esc('Totals'), esc('All organizations'), subBreakdown.total].join(','));

    rows.push([esc('Revenue'), esc('Total all-time (KES)'),        revenue.totalRevenue].join(','));
    rows.push([esc('Revenue'), esc('This month (KES)'),            revenue.currentMonthRevenue].join(','));
    rows.push([esc('Revenue'), esc('Last month (KES)'),            revenue.lastMonthRevenue].join(','));
    rows.push([esc('Revenue'), esc('Stripe volume (KES)'),         revenue.byProvider.STRIPE].join(','));
    rows.push([esc('Revenue'), esc('M-Pesa volume (KES)'),         revenue.byProvider.MPESA].join(','));
    rows.push([esc('Revenue'), esc('Payment success rate (%)'),    revenue.successRate].join(','));

    rows.push([esc('AI usage'), esc('Queries in range'),           aiUsage.totalQueries].join(','));
    rows.push([esc('AI usage'), esc('Policies completed'),         aiUsage.totalPolicies].join(','));
    rows.push([esc('AI usage'), esc('Checklists generated'),       aiUsage.totalChecklists].join(','));
    rows.push([esc('AI usage'), esc('Gap analyses'),               aiUsage.totalGapAnalyses].join(','));

    const buffer = Buffer.from(rows.join('\r\n'), 'utf-8');
    const key    = `exports/analytics/${nanoid(12)}.csv`;
    const ttl    = 300; // 5 minutes

    await r2PrivateClient.send(new PutObjectCommand({
      Bucket:      r2PrivateBucket,
      Key:         key,
      Body:        buffer,
      ContentType: 'text/csv',
      Metadata:    { 'generated-by': 'sheriabot-admin', format: 'csv' },
    }));

    const dateStr = new Date().toISOString().slice(0, 10);
    const url = await getSignedUrl(
      r2PrivateClient,
      new GetObjectCommand({
        Bucket:                     r2PrivateBucket,
        Key:                        key,
        ResponseContentType:        'text/csv',
        ResponseContentDisposition: `attachment; filename="sheriabot-analytics-${dateStr}.csv"`,
      }),
      { expiresIn: ttl },
    );

    const expiresAt = new Date(Date.now() + ttl * 1_000);

    logger.info({
      type:     'admin_analytics_export_generated',
      rowCount: rows.length - 1,
      key,
      expiresAt,
    });

    return { url, expiresAt };
  }

  // -- CSV builder -------------------------------------------------------------

  private buildAuditLogCsv(logs: AuditLogEntry[]): Buffer {
    const esc = (v: string | null | undefined): string => {
      const s = v ?? '';
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };

    const header = ['Timestamp', 'Action', 'Severity', 'Entity Type', 'Entity ID', 'User ID', 'Actor Name', 'Actor Email', 'Actor Organization', 'IP Address', 'Metadata'].join(',');
    const lines = logs.map((l) =>
      [
        esc(l.createdAt.toISOString()),
        esc(l.action),
        esc(l.severity),
        esc(l.entityType),
        esc(l.entityId),
        esc(l.userId),
        esc(l.actorName),
        esc(l.actorEmail),
        esc(l.actorOrganization),
        esc(l.ipAddress),
        esc(typeof l.metadata === 'object' ? JSON.stringify(l.metadata) : String(l.metadata ?? '')),
      ].join(',')
    );

    return Buffer.from([header, ...lines].join('\r\n'), 'utf-8');
  }

  // -- DOCX builder ------------------------------------------------------------

  private async buildAuditLogDocx(logs: AuditLogEntry[]): Promise<Buffer> {
    /** A4 content width in DXA (11906 - 2*1440). */
    const CONTENT_W = 9026;
    const CELL_BORDER = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } as const;
    const ALL_BORDERS = {
      top: CELL_BORDER, bottom: CELL_BORDER,
      left: CELL_BORDER, right: CELL_BORDER,
    } as const;

    const COL_WIDTHS = [1000, 1200, 600, 800, 800, 800, 800, 800, 800, 626, 800]; // sum = CONTENT_W

    const COLUMNS = ['Timestamp', 'Action', 'Severity', 'Entity Type', 'Entity ID', 'User ID', 'Actor Name', 'Actor Email', 'Actor Organization', 'IP Address', 'Metadata'];

    const headerRow = new TableRow({
      tableHeader: true,
      children: COLUMNS.map((text, i) =>
        new TableCell({
          width:   { size: COL_WIDTHS[i], type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, fill: '1A2B4A', color: 'FFFFFF' },
          borders: ALL_BORDERS,
          children: [
            new Paragraph({
              alignment: AlignmentType.LEFT,
              children: [new TextRun({ text, color: 'FFFFFF', bold: true, size: 18 })],
            }),
          ],
        })
      ),
    });

    const dataRows = logs.map((log) => {
      const cells = [
        log.createdAt.toISOString(),
        log.action,
        log.severity ?? '',
        log.entityType ?? '',
        log.entityId   ?? '',
        log.userId     ?? '',
        log.actorName  ?? '',
        log.actorEmail ?? '',
        log.actorOrganization ?? '',
        log.ipAddress  ?? '',
        typeof log.metadata === 'object' ? JSON.stringify(log.metadata) : String(log.metadata ?? ''),
      ];
      return new TableRow({
        children: cells.map((text, i) =>
          new TableCell({
            width:   { size: COL_WIDTHS[i], type: WidthType.DXA },
            shading: { type: ShadingType.CLEAR, fill: 'FFFFFF', color: 'auto' },
            borders: ALL_BORDERS,
            children: [
              new Paragraph({
                alignment: AlignmentType.LEFT,
                children: [new TextRun({ text, size: 16 })],
              }),
            ],
          })
        ),
      });
    });

    const generatedAt = new Date().toISOString();

    const doc = new Document({
      sections: [{
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 },
          },
        },
        children: [
          new Paragraph({
            alignment: AlignmentType.LEFT,
            children: [
              new TextRun({ text: 'SheriaBot  -  Audit Log Export', bold: true, size: 28, color: '1A2B4A' }),
            ],
            spacing: { after: 120 },
          }),
          new Paragraph({
            alignment: AlignmentType.LEFT,
            children: [
              new TextRun({ text: `Generated: ${generatedAt}  |  Rows: ${logs.length}`, size: 18, color: '4A5568' }),
            ],
            spacing: { after: 400 },
          }),
          new Table({
            width: { size: CONTENT_W, type: WidthType.DXA },
            rows:  [headerRow, ...dataRows],
          }),
        ],
      }],
    });

    return Buffer.from(await Packer.toBuffer(doc));
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  /**
   * Deletes the user-scoped plan context cache (`sheriabot:planctx:{userId}`)
   * for every member of an org so that `withPlanContext` re-fetches from DB
   * on the next request rather than serving the stale 5-minute cached plan.
   *
   * Non-fatal: a Redis failure must never prevent the plan update from being
   * visible on the next request (the DB is the source of truth; the cache
   * simply accelerates reads).
   */
  private async invalidatePlanCacheForOrg(orgId: string, source: string): Promise<void> {
    try {
      const users = await prisma.user.findMany({
        where:  { organizationId: orgId },
        select: { id: true },
      });

      await Promise.all(
        users.map((u) => redis.del(planCtxCacheKey(u.id)).catch(() => { /* non-fatal */ }))
      );

      logger.info({
        type:      'plan_cache_invalidated',
        orgId,
        userCount: users.length,
        source,
      });
    } catch (err) {
      logger.warn({ type: 'plan_cache_invalidation_failed', orgId, source, err: String(err) });
    }
  }

  private async invalidateOrganizationStatsCache(): Promise<void> {
    try {
      await redis.del(orgStatsKey());
    } catch (err) {
      logger.warn({ type: 'org_stats_cache_invalidation_failed', err: String(err) });
    }
  }

  /**
   * Public facade for the private writeAuditLog helper.
   * Use this from routers that need to record an audit entry without going
   * through a full service method (e.g., the export procedures).
   */
  async writeAuditLogEntry(
    adminId: string,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    return this.writeAuditLog(adminId, action, entityType, entityId, metadata);
  }

  private async writeAuditLog(
    adminId: string,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    try {
      await prisma.auditLog.create({
        data: {
          userId: adminId,
          action,
          entityType,
          entityId,
          metadata: metadata as object,
        },
      });
    } catch (err: unknown) {
      logger.error({
        type: 'audit_log_write_failed',
        action,
        entityId,
        error: (err as Error).message,
      });
    }
  }
}

export const adminModule = new AdminModule();
export { AdminModule };
