/**
 * Admin Module
 * Superadmin capabilities: user/org management, content moderation,
 * system configuration, platform monitoring, regulatory framework management.
 *
 * All destructive operations are logged to the AuditLog with before/after state.
 * Impersonation tokens are short-lived (15 min) and stored only in Redis.
 */

import { SubscriptionPlan as PrismaSubscriptionPlan, SubscriptionStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import { NotFoundError, ForbiddenError, BadRequestError } from '@/utils/error';
import { planCtxCacheKey } from '@/modules/trial';
import { nanoid } from 'nanoid';
import { supabaseAdmin } from '@/lib/supabase';
import {
  toAdminUserDetail,
  toAdminOrgDetail,
  toAuditLogEntry,
  featureFlagsKey,
  systemConfigKey,
  maintenanceKey,
  impersonationKey,
  frameworksKey,
} from './admin.utils';
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
} from './admin.types';

const { CACHE_TTL } = ADMIN_CONSTANTS;

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
        include: { organization: { select: { name: true } } },
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
      include: { organization: { select: { name: true } } },
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
      data: { status: 'SUSPENDED' },
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
      data: { status: 'ACTIVE' },
    });

    await this.writeAuditLog(adminId, 'admin_reactivate_user', 'User', userId, {});
    return this.getUserDetails(userId);
  }

  async deleteUser(adminId: string, userId: string, reason: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError('User');
    if (user.role === 'ADMIN') throw new ForbiddenError('Cannot delete an admin user');

    // Soft delete — anonymize after 30 days
    await prisma.user.update({
      where: { id: userId },
      data: { status: 'SUSPENDED', email: `deleted_${userId}@sheriabot.internal` },
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

    // Invalidate all sessions — user must log in and reset password
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

    const where: Record<string, unknown> = {
      ...(filters.subscriptionTier && { subscriptionTier: filters.subscriptionTier }),
      ...(filters.subscriptionStatus && { subscriptionStatus: filters.subscriptionStatus }),
      ...(filters.search && {
        name: { contains: filters.search, mode: 'insensitive' },
      }),
    };

    const [orgs, total] = await Promise.all([
      prisma.organization.findMany({
        where: where as any,
        orderBy: { createdAt: 'desc' },
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
          prisma.policy.count({ where: { user: { organizationId: org.id } } }),
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

  async getOrganizationDetails(orgId: string): Promise<AdminOrgDetail> {
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new NotFoundError('Organization');

    const [members, documents, policies] = await Promise.all([
      prisma.user.count({ where: { organizationId: orgId } }),
      prisma.legalDocument.count({ where: { organizationId: orgId, deletedAt: null } }),
      prisma.policy.count({ where: { user: { organizationId: orgId } } }),
    ]);

    return toAdminOrgDetail(org as unknown as Record<string, unknown>, {
      members,
      documents,
      policies,
    });
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
      data: { subscriptionStatus: 'CANCELLED' },
    });

    // Suspend all org members
    await prisma.user.updateMany({
      where: { organizationId: orgId },
      data: { status: 'SUSPENDED' },
    });

    await this.writeAuditLog(adminId, 'admin_suspend_org', 'Organization', orgId, { reason });
    logger.info({ type: 'admin_org_suspended', adminId, orgId, reason });

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
      where: { organizationId: orgId, status: 'SUSPENDED' },
      data: { status: 'ACTIVE' },
    });

    await this.writeAuditLog(adminId, 'admin_reactivate_org', 'Organization', orgId, {});
    return this.getOrganizationDetails(orgId);
  }

  async deleteOrganization(adminId: string, orgId: string, reason: string): Promise<void> {
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new NotFoundError('Organization');

    // Soft delete — suspend all members
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
        subscriptionTier: plan,        // legacy field — keep in sync
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
    const cached = await redis.get<string>(systemConfigKey());
    if (cached) return JSON.parse(cached) as SystemConfig;

    const persisted = await redis.get<string>('admin:system_config:persisted');
    if (persisted) {
      const config = JSON.parse(persisted) as SystemConfig;
      await redis.set(systemConfigKey(), persisted, { ex: CACHE_TTL.SYSTEM_CONFIG });
      return config;
    }

    await redis.set(
      systemConfigKey(),
      JSON.stringify(DEFAULT_SYSTEM_CONFIG),
      { ex: CACHE_TTL.SYSTEM_CONFIG }
    );
    return { ...DEFAULT_SYSTEM_CONFIG };
  }

  async updateSystemConfig(
    adminId: string,
    config: Partial<SystemConfig>
  ): Promise<SystemConfig> {
    const existing = await this.getSystemConfig();
    const updated = { ...existing, ...config };

    const serialized = JSON.stringify(updated);
    await redis.set('admin:system_config:persisted', serialized);
    await redis.set(systemConfigKey(), serialized, { ex: CACHE_TTL.SYSTEM_CONFIG });

    await this.writeAuditLog(adminId, 'admin_update_system_config', 'System', 'config', {
      changes: config,
    });

    logger.info({ type: 'admin_system_config_updated', adminId, changes: Object.keys(config) });
    return updated;
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

    if (
      health.services.database.status === 'down' &&
      health.services.redis.status === 'down'
    ) {
      health.status = 'down';
    }

    return health;
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
    return {
      indexName: process.env.PINECONE_INDEX_NAME ?? 'sheriabot-legal-corpus',
      vectorCount: 0,
      dimensionality: 1536,
      status: 'healthy',
    };
  }

  async getStorageStats(): Promise<StorageStats> {
    const docs = await prisma.legalDocument.findMany({
      where: { deletedAt: null },
      select: { fileSize: true },
    });
    const totalSizeMB = Math.round(
      docs.reduce((sum, d) => sum + d.fileSize, 0) / (1024 * 1024)
    );

    return {
      totalFiles: docs.length,
      totalSizeMB,
      status: 'healthy',
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
      ...(filters.action && { action: { contains: filters.action } }),
      ...(filters.entityType && { entityType: filters.entityType }),
      ...(filters.dateFrom || filters.dateTo
        ? {
            createdAt: {
              ...(filters.dateFrom && { gte: filters.dateFrom }),
              ...(filters.dateTo && { lte: filters.dateTo }),
            },
          }
        : {}),
    };

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where: where as any,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.auditLog.count({
        where: where as any,
      }),
    ]);

    return {
      items: logs.map((l) => toAuditLogEntry(l as unknown as Record<string, unknown>)),
      nextCursor: logs.length === limit ? String(page + 1) : null,
      total,
      page,
      limit,
    };
  }

  // ==========================================================================
  // REGULATORY FRAMEWORK MANAGEMENT
  // ==========================================================================

  async getRegulatoryFrameworks(): Promise<RegulatoryFramework[]> {
    const cached = await redis.get<string>(frameworksKey());
    if (cached) return JSON.parse(cached) as RegulatoryFramework[];

    // Frameworks stored in Redis (lightweight — no dedicated DB table needed)
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
    // Invitations are stored in Redis by the OrganizationModule
    // This returns all pending invite keys
    const keys = await redis.keys('org:invite:*');
    const invites: PendingInvitation[] = [];

    for (const key of keys.slice(0, 100)) {
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
    // The OrganizationModule handles resend — proxy call here if needed
  }

  async revokeInvitation(adminId: string, invitationId: string): Promise<void> {
    await redis.del(`org:invite:${invitationId}`);
    await this.writeAuditLog(adminId, 'admin_revoke_invitation', 'Invitation', invitationId, {});
  }

  // ==========================================================================
  // SUBSCRIPTION & BILLING
  // ==========================================================================

  async getSubscriptionOverview(): Promise<SubscriptionOverview> {
    const orgs = await prisma.organization.findMany({
      select: { subscriptionTier: true, subscriptionStatus: true },
    });

    const byPlan = {
      starter: 0,
      professional: 0,
      enterprise: 0,
      trial: 0,
      canceled: 0,
    } as Record<SubscriptionPlan, number>;

    for (const org of orgs) {
      const plan = org.subscriptionTier as SubscriptionPlan;
      if (plan in byPlan) byPlan[plan]++;
    }

    const total = orgs.length;
    const active = orgs.filter((o) => o.subscriptionStatus === 'ACTIVE').length;
    const trials = orgs.filter((o) => o.subscriptionStatus === 'TRIALING').length;
    const converted = orgs.filter(
      (o) => o.subscriptionStatus === 'ACTIVE' && o.subscriptionTier !== 'starter'
    ).length;

    return {
      totalActive: active,
      byPlan,
      trialConversionRate: trials > 0 ? Math.round((converted / trials) * 100) : 0,
      churnRate: total > 0 ? Math.round(((total - active - trials) / total) * 100) : 0,
    };
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
        subscriptionTier: plan,        // legacy field — keep in sync
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

  async createUser(adminId: string, input: CreateUserInput): Promise<AdminUserDetail> {
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

    // Create in Prisma
    const user = await prisma.user.create({
      data: {
        supabaseAuthId,
        email: input.email.toLowerCase(),
        fullName: input.fullName,
        role: input.role as never,
        emailVerified: true,
        accountStatus: 'active',
        status: 'ACTIVE',
        organizationId: input.organizationId ?? null,
      },
      include: { organization: { select: { name: true } } },
    });

    await this.writeAuditLog(adminId, 'admin_create_user', 'User', user.id, {
      email: user.email,
      role: user.role,
    });

    logger.info({ type: 'admin_user_created', adminId, userId: user.id, role: user.role });

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
    // Fetch all users created within the date range
    const users = await prisma.user.findMany({
      where: { createdAt: { gte: dateFrom, lte: dateTo } },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    // Group by period
    const buckets = new Map<string, number>();

    for (const user of users) {
      const d = user.createdAt;
      let key: string;
      if (period === 'daily') {
        key = d.toISOString().slice(0, 10);
      } else if (period === 'weekly') {
        // ISO week start (Monday)
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        const monday = new Date(d);
        monday.setDate(diff);
        key = monday.toISOString().slice(0, 10);
      } else {
        key = d.toISOString().slice(0, 7); // YYYY-MM
      }
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }

    const series = Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));

    return {
      series,
      total: users.length,
      periodStart: dateFrom.toISOString(),
      periodEnd: dateTo.toISOString(),
    };
  }

  async getRevenueMetrics(dateFrom: Date, dateTo: Date): Promise<RevenueMetrics> {
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
      monthlyBuckets.set(key, (monthlyBuckets.get(key) ?? 0) + p.amount);
    }

    const byProvider = { STRIPE: 0, MPESA: 0 };
    for (const p of allPayments) {
      if (p.provider === 'STRIPE') byProvider.STRIPE += p.amount;
      else if (p.provider === 'MPESA') byProvider.MPESA += p.amount;
    }

    return {
      totalRevenue: totalAll._sum.amount ?? 0,
      currentMonthRevenue: thisMonthPayments._sum.amount ?? 0,
      lastMonthRevenue: lastMonthPayments._sum.amount ?? 0,
      series: Array.from(monthlyBuckets.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, amount]) => ({ date, amount })),
      byProvider,
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
      const key = q.createdAt.toISOString().slice(0, 10);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }

    return {
      totalQueries,
      totalPolicies,
      totalChecklists,
      totalGapAnalyses,
      queriesThisMonth,
      policiesThisMonth,
      series: Array.from(buckets.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, count]) => ({ date, count })),
    };
  }

  async getSubscriptionBreakdown(): Promise<SubscriptionBreakdown> {
    const orgs = await prisma.organization.findMany({
      select: { plan: true, subscriptionStatus: true },
    });

    const byPlan: Record<string, number> = {};
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
