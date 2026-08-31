/**
 * Pilot Router
 *
 * Admin-only tRPC procedures for the Pilot Programme dashboard.
 * All procedures require ADMIN role (via adminProcedure).
 *
 * Procedures:
 *   pilot.getStats        -  aggregate stats (totals, cohorts)
 *   pilot.listTesters     -  per-tester rows with engagement metrics
 */

import { router, adminProcedure } from '../trpc/trpc';
import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { TRPCError } from '@trpc/server';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { appConfig } from '@/config/app.config';
import { reactMailer } from '@/lib/email/react-mailer.service';
import { redis } from '@/lib/redis/client';
import { hashPassword } from '@/utils/helpers';
import { supabaseAdmin } from '@/lib/supabase';
import { createUserWithOrganization, optionalOrganizationIdSchema } from '@/server/services/userProvisioning.service';
import { planCtxCacheKey } from '@/modules/trial';
import { AUDITED_JURISDICTIONS } from '@/config/jurisdictions.config';

const MS_PER_DAY    = 1000 * 60 * 60 * 24;
const MAX_ACTIONS   = 10; // total distinct PilotAction values
const TEMP_PASSWORD_TTL_MS = 60 * 60 * 1000;
const DEFAULT_PILOT_DAYS = 14;

const createPilotTesterSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  email: z.string().trim().email(),
  organizationId: optionalOrganizationIdSchema,
  organizationName: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(2).max(120).optional(),
  ),
  homeJurisdictionCode: z.enum(AUDITED_JURISDICTIONS).optional(),
  role: z.enum(['STARTUP', 'ENTERPRISE']).default('STARTUP'),
  phone: z.string().trim().max(40).optional(),
  temporaryPassword: z.string().min(10).max(128).optional(),
  pilotDurationDays: z.number().int().min(1).max(90).default(DEFAULT_PILOT_DAYS),
}).superRefine((value, ctx) => {
  if (!value.organizationId && !value.organizationName) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['organizationName'],
      message: 'Pilot users require an organization name or an existing organization.',
    });
  }
  if (!value.organizationId && !value.homeJurisdictionCode) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['homeJurisdictionCode'],
      message: 'A home jurisdiction is required when creating a pilot organization.',
    });
  }
});

const reissueTemporaryPasswordSchema = z.object({
  userId: z.string().min(1),
});

const extendPilotAccessSchema = z.object({
  userId: z.string().min(1),
  extensionDays: z.number().int().min(1).max(10),
  reason: z.string().trim().max(500).optional(),
});

const revokePilotAccessSchema = z.object({
  userId: z.string().min(1),
  reason: z.string().trim().max(500).optional(),
});

function generateTemporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  const bytes = randomBytes(18);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

async function invalidatePilotUserCaches(input: {
  userId: string;
  supabaseAuthId?: string | null;
  organizationId?: string | null;
}): Promise<void> {
  const keys = [
    planCtxCacheKey(input.userId),
    ...(input.supabaseAuthId ? [`user:session:${input.supabaseAuthId}`] : []),
    ...(input.organizationId ? [`sheriabot:orgmem:${input.userId}:${input.organizationId}`] : []),
  ];
  await Promise.all(keys.map((key) => redis.del(key).catch(() => {})));
}

async function sendPilotAccessEmail(input: {
  email: string;
  userName: string;
  organization: string;
  temporaryPassword: string;
  temporaryPasswordExpiresAt: Date;
  pilotExpiresAt: Date;
}): Promise<'SENT' | 'FAILED'> {
  try {
    await reactMailer.sendPilotWelcomeEmail(input.email, {
      userName: input.userName,
      organization: input.organization,
      pilotExpiresAt: input.pilotExpiresAt.toISOString(),
      dashboardUrl: `${appConfig.frontendUrl.replace(/\/$/, '')}/login`,
      temporaryPassword: input.temporaryPassword,
      temporaryPasswordExpiresAt: input.temporaryPasswordExpiresAt.toISOString(),
    });
    return 'SENT';
  } catch (error: unknown) {
    logger.error({
      type: 'pilot_access_email_failed',
      email: input.email,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'FAILED';
  }
}

export const pilotRouter = router({
  createPilotTester: adminProcedure
    .input(createPilotTesterSchema)
    .mutation(async ({ input, ctx }) => {
      const normalizedEmail = input.email.toLowerCase();
      const now = new Date();
      const temporaryPassword = input.temporaryPassword ?? generateTemporaryPassword();
      const passwordHash = await hashPassword(temporaryPassword);
      const temporaryPasswordExpiresAt = new Date(now.getTime() + TEMP_PASSWORD_TTL_MS);
      const pilotExpiresAt = new Date(now.getTime() + input.pilotDurationDays * MS_PER_DAY);

      const existing = await ctx.prisma.user.findUnique({
        where: { email: normalizedEmail },
        select: { id: true },
      });
      if (existing) {
        throw new TRPCError({ code: 'CONFLICT', message: 'A user with this email already exists.' });
      }

      const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email: normalizedEmail,
        password: temporaryPassword,
        email_confirm: true,
        user_metadata: { role: input.role, fullName: input.fullName },
      });

      if (authError || !authData.user) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to create pilot auth account.',
        });
      }

      try {
        const { user, organization } = await createUserWithOrganization({
          email: normalizedEmail,
          fullName: input.fullName,
          role: input.role,
          subscriptionTier: 'ENTERPRISE',
          isPilot: true,
          organizationId: input.organizationId,
          organizationName: input.organizationName,
          homeJurisdictionCode: input.homeJurisdictionCode,
          supabaseAuthId: authData.user.id,
          adminId: ctx.user!.id,
          requestId: `pilot-${Date.now()}`,
          passwordHash,
          mustChangePassword: true,
          temporaryPasswordIssuedAt: now,
          temporaryPasswordExpiresAt,
          temporaryPasswordDeliveryStatus: 'PENDING',
        });

        await ctx.prisma.user.update({
          where: { id: user.id },
          data: {
            phone: input.phone,
            pilotExpiresAt,
            pilotAccessStatus: 'ACTIVE',
            pilotExtensionCount: 0,
          } as any,
        });

        if (organization?.id) {
          await (ctx.prisma as any).pilotAccess.updateMany({
            where: {
              userId: user.id,
              organizationId: organization.id,
              status: 'ACTIVE',
            },
            data: {
              expiresAt: pilotExpiresAt,
              entitlementProfile: 'PILOT_FULL',
              extensionCount: 0,
              metadata: {
                source: 'pilot.createPilotTester',
                requestedDurationDays: input.pilotDurationDays,
                legacyUserPilotFieldsSynced: true,
              },
            },
          });
        }

        const deliveryStatus = await sendPilotAccessEmail({
          email: normalizedEmail,
          userName: input.fullName,
          organization: organization?.name ?? input.organizationName ?? 'your organization',
          temporaryPassword,
          temporaryPasswordExpiresAt,
          pilotExpiresAt,
        });

        await ctx.prisma.user.update({
          where: { id: user.id },
          data: { temporaryPasswordDeliveryStatus: deliveryStatus } as any,
        });

        await ctx.prisma.auditLog.create({
          data: {
            userId: ctx.user!.id,
            action: 'PILOT_TESTER_CREATED',
            entityType: 'User',
            entityId: user.id,
            metadata: {
              targetUserId: user.id,
              organizationId: organization?.id ?? null,
              temporaryPasswordExpiresAt: temporaryPasswordExpiresAt.toISOString(),
              pilotAccessExpiresAt: pilotExpiresAt.toISOString(),
              emailDeliveryStatus: deliveryStatus,
            },
          },
        });

        await invalidatePilotUserCaches({
          userId: user.id,
          supabaseAuthId: authData.user.id,
          organizationId: organization?.id ?? null,
        });

        logger.info({
          type: 'pilot_tester_created',
          adminId: ctx.user!.id,
          userId: user.id,
          organizationId: organization?.id ?? null,
          emailDeliveryStatus: deliveryStatus,
        });

        return {
          success: true,
          userId: user.id,
          organizationId: organization?.id ?? null,
          temporaryPasswordExpiresAt: temporaryPasswordExpiresAt.toISOString(),
          pilotAccessExpiresAt: pilotExpiresAt.toISOString(),
          emailDeliveryStatus: deliveryStatus,
        };
      } catch (error: unknown) {
        await supabaseAdmin.auth.admin.deleteUser(authData.user.id).catch(() => {});
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to provision pilot tester.',
          cause: error,
        });
      }
    }),

  reissueTemporaryPassword: adminProcedure
    .input(reissueTemporaryPasswordSchema)
    .mutation(async ({ input, ctx }) => {
      const user = await ctx.prisma.user.findUnique({
        where: { id: input.userId },
        select: {
          id: true,
          email: true,
          fullName: true,
          password: true,
          supabaseAuthId: true,
          organizationId: true,
          isPilot: true,
          mustChangePassword: true,
          pilotExpiresAt: true,
          organization: { select: { name: true } },
        },
      });

      if (!user || !user.isPilot) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Pilot user not found.' });
      }

      const temporaryPassword = generateTemporaryPassword();
      const passwordHash = await hashPassword(temporaryPassword);
      const now = new Date();
      const temporaryPasswordExpiresAt = new Date(now.getTime() + TEMP_PASSWORD_TTL_MS);

      if ((user as any).supabaseAuthId) {
        const { error } = await supabaseAdmin.auth.admin.updateUserById((user as any).supabaseAuthId, {
          password: temporaryPassword,
        });
        if (error) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to update auth password.' });
        }
        await supabaseAdmin.auth.admin.signOut((user as any).supabaseAuthId).catch(() => {});
      }

      await ctx.prisma.user.update({
        where: { id: user.id },
        data: {
          password: passwordHash,
          mustChangePassword: true,
          temporaryPasswordIssuedAt: now,
          temporaryPasswordExpiresAt,
          temporaryPasswordUsedAt: null,
          temporaryPasswordCreatedByAdminId: ctx.user!.id,
          temporaryPasswordDeliveryStatus: 'PENDING',
          temporaryPasswordVersion: { increment: 1 },
        } as any,
      });

      const deliveryStatus = await sendPilotAccessEmail({
        email: user.email,
        userName: user.fullName,
        organization: (user as any).organization?.name ?? 'your organization',
        temporaryPassword,
        temporaryPasswordExpiresAt,
        pilotExpiresAt: user.pilotExpiresAt ?? new Date(Date.now() + DEFAULT_PILOT_DAYS * MS_PER_DAY),
      });

      await ctx.prisma.user.update({
        where: { id: user.id },
        data: { temporaryPasswordDeliveryStatus: deliveryStatus } as any,
      });

      await ctx.prisma.session.deleteMany({ where: { userId: user.id } });
      await invalidatePilotUserCaches({
        userId: user.id,
        supabaseAuthId: (user as any).supabaseAuthId,
        organizationId: user.organizationId,
      });

      await ctx.prisma.auditLog.create({
        data: {
          userId: ctx.user!.id,
          action: 'PILOT_TEMP_PASSWORD_REISSUED',
          entityType: 'User',
          entityId: user.id,
          metadata: {
            targetUserId: user.id,
            temporaryPasswordExpiresAt: temporaryPasswordExpiresAt.toISOString(),
            emailDeliveryStatus: deliveryStatus,
          },
        },
      });

      return {
        success: true,
        temporaryPasswordExpiresAt: temporaryPasswordExpiresAt.toISOString(),
        emailDeliveryStatus: deliveryStatus,
      };
    }),

  extendPilotAccess: adminProcedure
    .input(extendPilotAccessSchema)
    .mutation(async ({ input, ctx }) => {
      const user = await ctx.prisma.user.findUnique({
        where: { id: input.userId },
        select: {
          id: true,
          isPilot: true,
          pilotAccessStatus: true,
          pilotExpiresAt: true,
          pilotExtensionCount: true,
          organizationId: true,
          supabaseAuthId: true,
        },
      });

      if (!user || !user.isPilot) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Pilot user not found.' });
      }

      if ((user as any).pilotAccessStatus === 'REVOKED' || (user as any).pilotAccessStatus === 'CONVERTED') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'This pilot access cannot be extended.' });
      }

      const extensionCount = (user as any).pilotExtensionCount ?? 0;
      const maxDays = extensionCount === 0 ? 10 : extensionCount === 1 ? 5 : 0;
      if (maxDays === 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Maximum pilot extensions reached. User must choose a paid plan or continue on the free version.',
        });
      }
      if (input.extensionDays > maxDays) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `This extension can be at most ${maxDays} days.`,
        });
      }

      const now = new Date();
      const base = user.pilotExpiresAt && user.pilotExpiresAt > now ? user.pilotExpiresAt : now;
      const nextExpiresAt = new Date(base.getTime() + input.extensionDays * MS_PER_DAY);
      const nextExtensionCount = extensionCount + 1;

      await ctx.prisma.user.update({
        where: { id: user.id },
        data: {
          pilotAccessStatus: 'ACTIVE',
          pilotExpiresAt: nextExpiresAt,
          pilotExtensionCount: nextExtensionCount,
          pilotLastExtendedByAdminId: ctx.user!.id,
          ...(nextExtensionCount === 1
            ? { pilotFirstExtensionGrantedAt: now }
            : { pilotSecondExtensionGrantedAt: now }),
        } as any,
      });

      if (user.organizationId) {
        const existingAccess = await (ctx.prisma as any).pilotAccess.findFirst({
          where: { userId: user.id, organizationId: user.organizationId, status: 'ACTIVE' },
          select: { id: true },
        }).catch(() => null);

        if (existingAccess) {
          await (ctx.prisma as any).pilotAccess.update({
            where: { id: existingAccess.id },
            data: {
              status: 'ACTIVE',
              expiresAt: nextExpiresAt,
              extensionCount: nextExtensionCount,
              lastExtendedByAdminId: ctx.user!.id,
              metadata: {
                source: 'pilot.extendPilotAccess',
                reason: input.reason ?? null,
                legacyUserPilotFieldsSynced: true,
              },
            },
          });
        } else {
          await (ctx.prisma as any).pilotAccess.create({
            data: {
              userId: user.id,
              organizationId: user.organizationId,
              status: 'ACTIVE',
              entitlementProfile: 'PILOT_FULL',
              startsAt: new Date(),
              expiresAt: nextExpiresAt,
              extensionCount: nextExtensionCount,
              createdByAdminId: ctx.user!.id,
              lastExtendedByAdminId: ctx.user!.id,
              metadata: {
                source: 'pilot.extendPilotAccess.backfill',
                reason: input.reason ?? null,
                legacyUserPilotFieldsSynced: true,
              },
            },
          });
        }
      }

      await invalidatePilotUserCaches({
        userId: user.id,
        supabaseAuthId: (user as any).supabaseAuthId,
        organizationId: user.organizationId,
      });

      await ctx.prisma.auditLog.create({
        data: {
          userId: ctx.user!.id,
          action: 'PILOT_ACCESS_EXTENDED',
          entityType: 'User',
          entityId: user.id,
          metadata: {
            targetUserId: user.id,
            extensionDays: input.extensionDays,
            extensionCount: nextExtensionCount,
            pilotAccessExpiresAt: nextExpiresAt.toISOString(),
            reason: input.reason ?? null,
          },
        },
      });

      return {
        success: true,
        pilotAccessExpiresAt: nextExpiresAt.toISOString(),
        pilotExtensionCount: nextExtensionCount,
      };
    }),

  revokePilotAccess: adminProcedure
    .input(revokePilotAccessSchema)
    .mutation(async ({ input, ctx }) => {
      const user = await ctx.prisma.user.findUnique({
        where: { id: input.userId },
        select: {
          id: true,
          isPilot: true,
          organizationId: true,
          supabaseAuthId: true,
        },
      });

      if (!user || !user.isPilot) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Pilot user not found.' });
      }

      await ctx.prisma.user.update({
        where: { id: user.id },
        data: {
          pilotAccessStatus: 'REVOKED',
          pilotExpiresAt: new Date(),
        },
      });

      if (user.organizationId) {
        await (ctx.prisma as any).pilotAccess.updateMany({
          where: {
            userId: user.id,
            organizationId: user.organizationId,
            status: 'ACTIVE',
          },
          data: {
            status: 'REVOKED',
            revokedAt: new Date(),
            revokedByAdminId: ctx.user!.id,
            metadata: {
              source: 'pilot.revokePilotAccess',
              reason: input.reason ?? null,
              legacyUserPilotFieldsSynced: true,
            },
          },
        });
      }

      await ctx.prisma.session.deleteMany({ where: { userId: user.id } });
      if (user.supabaseAuthId) {
        await supabaseAdmin.auth.admin.signOut(user.supabaseAuthId).catch(() => {});
      }

      await invalidatePilotUserCaches({
        userId: user.id,
        supabaseAuthId: user.supabaseAuthId,
        organizationId: user.organizationId,
      });

      await ctx.prisma.auditLog.create({
        data: {
          userId: ctx.user!.id,
          action: 'PILOT_ACCESS_REVOKED',
          entityType: 'User',
          entityId: user.id,
          metadata: {
            targetUserId: user.id,
            reason: input.reason ?? null,
          },
        },
      });

      return { success: true };
    }),

  /**
   * Aggregate stats for the pilot programme header cards.
   */
  getStats: adminProcedure.query(async () => {
    const now = new Date();

    const [total, expiredCount, convertedCount, totalEvents, cohortRows] = await Promise.all([
      prisma.user.count({ where: { isPilot: true } }),
      prisma.user.count({ where: { isPilot: true, OR: [{ pilotAccessStatus: 'EXPIRED' }, { pilotExpiresAt: { lte: now } }] } as any }),
      prisma.user.count({ where: { isPilot: true, pilotConvertedAt: { not: null } } }),
      prisma.pilotEvent.count(),
      prisma.user.findMany({
        where:    { isPilot: true, pilotCohort: { not: null } },
        select:   { pilotCohort: true },
        distinct: ['pilotCohort'],
      }),
    ]);

    const active = Math.max(0, total - expiredCount - convertedCount);

    logger.info({ type: 'PILOT_ADMIN_GET_STATS', total, active, expiredCount, convertedCount });

    return {
      total,
      active,
      expired:     expiredCount,
      converted:   convertedCount,
      totalEvents,
      cohorts:     cohortRows.map((r) => r.pilotCohort ?? '').filter(Boolean),
    };
  }),

  /**
   * Per-tester rows with engagement metrics.
   * Sorted newest-first by pilotStartedAt.
   */
  listTesters: adminProcedure.query(async () => {
    const now = new Date();

    const users = await prisma.user.findMany({
      where:   { isPilot: true },
      select: {
        id:               true,
        email:            true,
        fullName:         true,
        pilotCohort:      true,
        pilotStartedAt:   true,
        pilotExpiresAt:   true,
        pilotAccessStatus: true,
        pilotExtensionCount: true,
        pilotFirstExtensionGrantedAt: true,
        pilotSecondExtensionGrantedAt: true,
        pilotConvertedAt: true,
        organization:     { select: { name: true } },
        pilotEvents:      { select: { action: true, createdAt: true }, orderBy: { createdAt: 'desc' } },
      },
      orderBy: { pilotStartedAt: 'desc' },
    });

    logger.info({ type: 'PILOT_ADMIN_LIST_TESTERS', count: users.length });

    return users.map((user) => {
      const isExpired   = (user as any).pilotAccessStatus === 'EXPIRED' || (user.pilotExpiresAt !== null && user.pilotExpiresAt <= now);
      const isConverted = user.pilotConvertedAt !== null;
      const isRevoked   = (user as any).pilotAccessStatus === 'REVOKED';
      const status      = isConverted ? 'converted' : isRevoked ? 'revoked' : isExpired ? 'expired' : 'active';

      const daysRemaining = user.pilotExpiresAt && !isExpired
        ? Math.max(0, Math.ceil((user.pilotExpiresAt.getTime() - now.getTime()) / MS_PER_DAY))
        : 0;

      const daysSinceStart = user.pilotStartedAt
        ? Math.floor((now.getTime() - user.pilotStartedAt.getTime()) / MS_PER_DAY)
        : 0;

      // Engagement score = count of distinct action types used (max 10)
      const distinctActions  = new Set(user.pilotEvents.map((e) => e.action));
      const engagementScore  = distinctActions.size;
      const engagementPercent = Math.round((engagementScore / MAX_ACTIONS) * 100);

      // Events grouped by action
      const eventsByAction: Record<string, number> = {};
      for (const event of user.pilotEvents) {
        eventsByAction[event.action] = (eventsByAction[event.action] ?? 0) + 1;
      }

      const lastEventAt = user.pilotEvents[0]?.createdAt ?? null;

      return {
        id:               user.id,
        email:            user.email,
        fullName:         user.fullName,
        organization:     user.organization?.name ?? null,
        cohort:           user.pilotCohort,
        pilotStartedAt:   user.pilotStartedAt?.toISOString()   ?? null,
        pilotExpiresAt:   user.pilotExpiresAt?.toISOString()   ?? null,
        pilotConvertedAt: user.pilotConvertedAt?.toISOString() ?? null,
        pilotAccessStatus: (user as any).pilotAccessStatus ?? null,
        pilotExtensionCount: (user as any).pilotExtensionCount ?? 0,
        pilotFirstExtensionGrantedAt: (user as any).pilotFirstExtensionGrantedAt?.toISOString() ?? null,
        pilotSecondExtensionGrantedAt: (user as any).pilotSecondExtensionGrantedAt?.toISOString() ?? null,
        status,
        daysRemaining,
        daysSinceStart,
        engagementScore,
        engagementPercent,
        totalEvents: user.pilotEvents.length,
        lastEventAt: lastEventAt?.toISOString() ?? null,
        eventsByAction,
      };
    });
  }),
});
