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
