import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { SubscriptionPlan } from '@prisma/client';
import { router, protectedProcedure } from '../trpc/trpc';
import { withPlanContext } from '../trpc/middleware';
import { allowedFrameworkTiersForPlan, canAccessFrameworkTier } from '../services/framework-access.service';

const frameworkSelect = {
  id: true,
  slug: true,
  name: true,
  description: true,
  category: true,
  tier: true,
  isActive: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toFrameworkMetadata(framework: {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string;
  tier: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  documentCount?: number;
}) {
  return {
    id: framework.id,
    slug: framework.slug,
    name: framework.name,
    description: framework.description,
    category: framework.category,
    tier: framework.tier,
    isActive: framework.isActive,
    version: null as string | null,
    documentCount: framework.documentCount ?? 0,
    isCustom: false,
    organizationId: null as string | null,
    createdAt: framework.createdAt,
    updatedAt: framework.updatedAt,
  };
}

export const frameworkRouter = router({
  list: protectedProcedure
    .use(withPlanContext)
    .input(z.object({ includeInactive: z.boolean().optional().default(false) }).optional())
    .query(async ({ input, ctx }) => {
      const isPlatformAdmin = ctx.user!.role === 'ADMIN';
      const plan = ctx.plan ?? SubscriptionPlan.REGULATOR;
      const includeInactive = Boolean(input?.includeInactive && isPlatformAdmin);

      const frameworks = await ctx.prisma.regulatoryFramework.findMany({
        where: {
          ...(includeInactive ? {} : { isActive: true }),
          ...(isPlatformAdmin ? {} : { tier: { in: allowedFrameworkTiersForPlan(plan) } }),
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: frameworkSelect,
      });

      if (frameworks.length === 0) return [];

      const documentCounts = await ctx.prisma.legalDocument.groupBy({
        by: ['category'],
        where: {
          category: { in: frameworks.map((framework) => framework.slug) },
          deletedAt: null,
        },
        _count: { _all: true },
      });
      const countBySlug = new Map(documentCounts.map((row) => [row.category, row._count._all]));

      return frameworks.map((framework) =>
        toFrameworkMetadata({
          ...framework,
          documentCount: countBySlug.get(framework.slug) ?? 0,
        }),
      );
    }),

  getBySlug: protectedProcedure
    .use(withPlanContext)
    .input(z.object({ slug: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      const isPlatformAdmin = ctx.user!.role === 'ADMIN';
      const plan = ctx.plan ?? SubscriptionPlan.REGULATOR;

      const framework = await ctx.prisma.regulatoryFramework.findUnique({
        where: { slug: input.slug },
        select: frameworkSelect,
      });

      if (!framework || (!framework.isActive && !isPlatformAdmin)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Framework not found.' });
      }

      if (!isPlatformAdmin && !canAccessFrameworkTier(plan, framework.tier)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Your plan does not include this framework.' });
      }

      const documentCount = await ctx.prisma.legalDocument.count({
        where: { category: framework.slug, deletedAt: null },
      });

      return toFrameworkMetadata({ ...framework, documentCount });
    }),
});
