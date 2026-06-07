import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, router } from '../trpc/trpc';
import { PLAN_ENTITLEMENTS, SubscriptionPlan } from '@/config/entitlements.config';
import { redis } from '@/lib/redis/client';
import { planCtxCacheKey } from '@/modules/trial';
import {
  allowedEnterpriseOverrideKeys,
  applyEnterpriseContractOverrides,
  parseEnterpriseOverrideValue,
} from '@/modules/billing/enterprise-contract-overrides';

const reasonSchema = z.string().trim().min(10).max(1000);
const contractMetadataSchema = z.object({
  organizationId: z.string().min(1),
  contractName: z.string().trim().max(160).optional().nullable(),
  contractNumber: z.string().trim().max(120).optional().nullable(),
  startsAt: z.coerce.date().optional().nullable(),
  endsAt: z.coerce.date().optional().nullable(),
  renewalDate: z.coerce.date().optional().nullable(),
  billingCycle: z.string().trim().max(60).optional().nullable(),
  currency: z.string().trim().min(3).max(3).optional().nullable(),
  monthlyAmount: z.number().nonnegative().optional().nullable(),
  annualAmount: z.number().nonnegative().optional().nullable(),
  notes: z.string().trim().max(5000).optional().nullable(),
});
const overrideSchema = z.object({
  contractId: z.string().min(1),
  key: z.enum(allowedEnterpriseOverrideKeys),
  value: z.unknown(),
  startsAt: z.coerce.date().optional().nullable(),
  endsAt: z.coerce.date().optional().nullable(),
  reason: reasonSchema,
});

async function audit(ctx: any, action: string, entityType: string, entityId: string, metadata: Record<string, unknown>) {
  await ctx.prisma.auditLog.create({
    data: {
      userId: ctx.user.id,
      action,
      entityType,
      entityId,
      metadata,
    },
  }).catch(() => {});
}

async function invalidatePlanCacheForOrg(ctx: any, organizationId: string, source: string) {
  const users = await ctx.prisma.user.findMany({ where: { organizationId }, select: { id: true } });
  await Promise.all(users.map((user: { id: string }) => redis.del(planCtxCacheKey(user.id)).catch(() => {})));
  await audit(ctx, 'enterprise_contract.plan_cache_invalidated', 'Organization', organizationId, {
    source,
    userCount: users.length,
  });
}

async function getContractOrThrow(ctx: any, id: string) {
  const contract = await (ctx.prisma as any).enterpriseContract.findFirst({
    where: { id, deletedAt: null },
    include: {
      organization: { select: { id: true, name: true, plan: true, subscriptionStatus: true } },
      overrides: { orderBy: [{ createdAt: 'desc' }] },
    },
  });
  if (!contract) throw new TRPCError({ code: 'NOT_FOUND', message: 'Enterprise contract not found.' });
  return contract;
}

async function previewForOrganization(ctx: any, organizationId: string, now = new Date()) {
  const org = await ctx.prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true, plan: true },
  });
  if (!org) throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found.' });

  const rows = await (ctx.prisma as any).enterprisePlanOverride.findMany({
    where: {
      organizationId,
      isActive: true,
      OR: [{ startsAt: null }, { startsAt: { lte: now } }],
      AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
      contract: {
        organizationId,
        status: 'ACTIVE',
        deletedAt: null,
        OR: [{ startsAt: null }, { startsAt: { lte: now } }],
        AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
      },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, contractId: true, key: true, value: true },
  });
  const baseEntitlements = PLAN_ENTITLEMENTS[org.plan as SubscriptionPlan] ?? PLAN_ENTITLEMENTS.REGULATOR;
  const resolved = applyEnterpriseContractOverrides(baseEntitlements, rows);

  return {
    organization: org,
    planDefault: baseEntitlements,
    effectiveEntitlements: resolved.entitlements,
    appliedOverrides: resolved.appliedOverrides,
  };
}

export const enterpriseContractRouter = router({
  adminList: adminProcedure
    .input(z.object({ organizationId: z.string().optional(), status: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      return (ctx.prisma as any).enterpriseContract.findMany({
        where: {
          deletedAt: null,
          ...(input?.organizationId ? { organizationId: input.organizationId } : {}),
          ...(input?.status ? { status: input.status } : {}),
        },
        include: {
          organization: { select: { id: true, name: true, plan: true } },
          _count: { select: { overrides: true } },
        },
        orderBy: [{ updatedAt: 'desc' }],
      });
    }),

  adminGet: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ ctx, input }) => getContractOrThrow(ctx, input.id)),

  adminCreate: adminProcedure
    .input(contractMetadataSchema.extend({ reason: reasonSchema }))
    .mutation(async ({ ctx, input }) => {
      const org = await ctx.prisma.organization.findUnique({ where: { id: input.organizationId }, select: { id: true } });
      if (!org) throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found.' });
      const { reason, ...data } = input;
      const contract = await (ctx.prisma as any).enterpriseContract.create({
        data: { ...data, createdByUserId: ctx.user!.id },
      });
      await audit(ctx, 'enterprise_contract.created', 'EnterpriseContract', contract.id, {
        organizationId: input.organizationId,
        reason,
      });
      return contract;
    }),

  adminUpdate: adminProcedure
    .input(contractMetadataSchema.partial().extend({ id: z.string().min(1), reason: reasonSchema }))
    .mutation(async ({ ctx, input }) => {
      const contract = await getContractOrThrow(ctx, input.id);
      const { id, reason, organizationId: _organizationId, ...data } = input;
      const updated = await (ctx.prisma as any).enterpriseContract.update({
        where: { id },
        data: { ...data, updatedByUserId: ctx.user!.id },
      });
      await audit(ctx, 'enterprise_contract.updated', 'EnterpriseContract', id, {
        organizationId: contract.organizationId,
        fields: Object.keys(data),
        reason,
      });
      await invalidatePlanCacheForOrg(ctx, contract.organizationId, 'enterprise_contract_updated');
      return updated;
    }),

  adminActivate: adminProcedure
    .input(z.object({ id: z.string().min(1), reason: reasonSchema }))
    .mutation(async ({ ctx, input }) => {
      const contract = await getContractOrThrow(ctx, input.id);
      const updated = await (ctx.prisma as any).enterpriseContract.update({
        where: { id: input.id },
        data: { status: 'ACTIVE', approvedByUserId: ctx.user!.id, updatedByUserId: ctx.user!.id },
      });
      await audit(ctx, 'enterprise_contract.activated', 'EnterpriseContract', input.id, {
        organizationId: contract.organizationId,
        reason: input.reason,
      });
      await invalidatePlanCacheForOrg(ctx, contract.organizationId, 'enterprise_contract_activated');
      return updated;
    }),

  adminSuspend: adminProcedure
    .input(z.object({ id: z.string().min(1), reason: reasonSchema }))
    .mutation(async ({ ctx, input }) => {
      const contract = await getContractOrThrow(ctx, input.id);
      const updated = await (ctx.prisma as any).enterpriseContract.update({
        where: { id: input.id },
        data: { status: 'SUSPENDED', updatedByUserId: ctx.user!.id },
      });
      await audit(ctx, 'enterprise_contract.suspended', 'EnterpriseContract', input.id, {
        organizationId: contract.organizationId,
        reason: input.reason,
      });
      await invalidatePlanCacheForOrg(ctx, contract.organizationId, 'enterprise_contract_suspended');
      return updated;
    }),

  adminArchive: adminProcedure
    .input(z.object({ id: z.string().min(1), reason: reasonSchema }))
    .mutation(async ({ ctx, input }) => {
      const contract = await getContractOrThrow(ctx, input.id);
      const updated = await (ctx.prisma as any).enterpriseContract.update({
        where: { id: input.id },
        data: { status: 'ARCHIVED', deletedAt: new Date(), updatedByUserId: ctx.user!.id },
      });
      await audit(ctx, 'enterprise_contract.archived', 'EnterpriseContract', input.id, {
        organizationId: contract.organizationId,
        reason: input.reason,
      });
      await invalidatePlanCacheForOrg(ctx, contract.organizationId, 'enterprise_contract_archived');
      return updated;
    }),

  adminAddOverride: adminProcedure
    .input(overrideSchema)
    .mutation(async ({ ctx, input }) => {
      const contract = await getContractOrThrow(ctx, input.contractId);
      const value = parseEnterpriseOverrideValue(input.key, input.value);
      const override = await (ctx.prisma as any).enterprisePlanOverride.create({
        data: {
          contractId: input.contractId,
          organizationId: contract.organizationId,
          key: input.key,
          value,
          reason: input.reason,
          startsAt: input.startsAt ?? null,
          endsAt: input.endsAt ?? null,
          createdByUserId: ctx.user!.id,
        },
      });
      await audit(ctx, 'enterprise_contract.override_added', 'EnterprisePlanOverride', override.id, {
        organizationId: contract.organizationId,
        contractId: input.contractId,
        key: input.key,
        reason: input.reason,
      });
      await invalidatePlanCacheForOrg(ctx, contract.organizationId, 'enterprise_override_added');
      return override;
    }),

  adminUpdateOverride: adminProcedure
    .input(overrideSchema.partial().extend({ id: z.string().min(1), reason: reasonSchema }))
    .mutation(async ({ ctx, input }) => {
      const override = await (ctx.prisma as any).enterprisePlanOverride.findUnique({ where: { id: input.id } });
      if (!override) throw new TRPCError({ code: 'NOT_FOUND', message: 'Override not found.' });
      const key = input.key ?? override.key;
      const value = input.value === undefined ? override.value : parseEnterpriseOverrideValue(key, input.value);
      const updated = await (ctx.prisma as any).enterprisePlanOverride.update({
        where: { id: input.id },
        data: {
          key,
          value,
          reason: input.reason,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          updatedByUserId: ctx.user!.id,
        },
      });
      await audit(ctx, 'enterprise_contract.override_updated', 'EnterprisePlanOverride', input.id, {
        organizationId: override.organizationId,
        contractId: override.contractId,
        key,
        reason: input.reason,
      });
      await invalidatePlanCacheForOrg(ctx, override.organizationId, 'enterprise_override_updated');
      return updated;
    }),

  adminDisableOverride: adminProcedure
    .input(z.object({ id: z.string().min(1), reason: reasonSchema }))
    .mutation(async ({ ctx, input }) => {
      const override = await (ctx.prisma as any).enterprisePlanOverride.findUnique({ where: { id: input.id } });
      if (!override) throw new TRPCError({ code: 'NOT_FOUND', message: 'Override not found.' });
      const updated = await (ctx.prisma as any).enterprisePlanOverride.update({
        where: { id: input.id },
        data: { isActive: false, reason: input.reason, updatedByUserId: ctx.user!.id },
      });
      await audit(ctx, 'enterprise_contract.override_disabled', 'EnterprisePlanOverride', input.id, {
        organizationId: override.organizationId,
        contractId: override.contractId,
        key: override.key,
        reason: input.reason,
      });
      await invalidatePlanCacheForOrg(ctx, override.organizationId, 'enterprise_override_disabled');
      return updated;
    }),

  adminPreviewEffectiveEntitlements: adminProcedure
    .input(z.object({ organizationId: z.string().min(1) }))
    .query(async ({ ctx, input }) => previewForOrganization(ctx, input.organizationId)),
});
