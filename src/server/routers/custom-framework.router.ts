import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { MemberRole } from '@prisma/client';
import { router, orgMemberProcedureWithRole, orgMemberProcedure } from '../trpc/trpc';
import { requirePlanFeature, withPlanContext } from '../trpc/middleware';
import { logger } from '@/utils/logger';
import { AUDITED_JURISDICTIONS } from '@/config/jurisdictions.config';

const managerRoles = [MemberRole.ADMIN, MemberRole.OWNER];

const idSchema = z.object({ id: z.string().min(1) });
const jurisdictionSchema = z.enum(AUDITED_JURISDICTIONS);
const metadataSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(5000).optional().nullable(),
  jurisdiction: jurisdictionSchema.optional().nullable(),
  regulator: z.string().trim().max(120).optional().nullable(),
  category: z.string().trim().max(120).optional().nullable(),
});
const sectionSchema = z.object({
  frameworkId: z.string().min(1),
  title: z.string().trim().min(2).max(180),
  description: z.string().trim().max(3000).optional().nullable(),
  order: z.number().int().min(0).default(0),
});
const updateSectionSchema = sectionSchema.partial().extend({ id: z.string().min(1) }).omit({ frameworkId: true });
const controlSchema = z.object({
  frameworkId: z.string().min(1),
  sectionId: z.string().min(1).optional().nullable(),
  code: z.string().trim().max(80).optional().nullable(),
  title: z.string().trim().min(2).max(220),
  requirement: z.string().trim().min(2).max(10000),
  guidance: z.string().trim().max(10000).optional().nullable(),
  evidenceRequired: z.unknown().optional().nullable(),
  severity: z.string().trim().max(80).optional().nullable(),
  frequency: z.string().trim().max(80).optional().nullable(),
  regulatorReference: z.string().trim().max(240).optional().nullable(),
  order: z.number().int().min(0).default(0),
});
const updateControlSchema = controlSchema.partial().extend({ id: z.string().min(1) }).omit({ frameworkId: true });

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'framework';
}

async function uniqueFrameworkSlug(ctx: any, organizationId: string, name: string): Promise<string> {
  const baseSlug = slugify(name);
  let slug = baseSlug;
  let suffix = 2;

  while (await (ctx.prisma as any).customFramework.findFirst({ where: { organizationId, slug }, select: { id: true } })) {
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  return slug;
}

async function audit(ctx: any, action: string, entityId: string, metadata: Record<string, unknown>) {
  await ctx.prisma.auditLog.create({
    data: {
      userId: ctx.user.id,
      action,
      entityType: 'CustomFramework',
      entityId,
      metadata,
    },
  }).catch(() => {});
}

async function getFrameworkOrThrow(ctx: any, id: string, organizationId: string) {
  const framework = await (ctx.prisma as any).customFramework.findFirst({
    where: { id, organizationId, deletedAt: null },
    include: {
      sections: { orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] },
      controls: { orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] },
      versions: { orderBy: { version: 'desc' } },
    },
  });
  if (!framework) throw new TRPCError({ code: 'FORBIDDEN', message: 'Custom framework not found or inaccessible.' });
  return framework;
}

function assertDraft(framework: { status: string }) {
  if (framework.status !== 'DRAFT') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Only draft frameworks can be edited.' });
  }
}

export const customFrameworkRouter = router({
  list: orgMemberProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('customFrameworks'))
    .input(z.object({ status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const organizationId = ctx.orgMembership!.organizationId;
      const frameworks = await (ctx.prisma as any).customFramework.findMany({
        where: {
          organizationId,
          deletedAt: null,
          ...(input?.status ? { status: input.status } : {}),
        },
        include: { _count: { select: { sections: true, controls: true } } },
        orderBy: [{ updatedAt: 'desc' }],
      });
      return frameworks;
    }),

  get: orgMemberProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('customFrameworks'))
    .input(idSchema)
    .query(async ({ ctx, input }) => getFrameworkOrThrow(ctx, input.id, ctx.orgMembership!.organizationId)),

  create: orgMemberProcedureWithRole(managerRoles)
    .use(withPlanContext)
    .use(requirePlanFeature('customFrameworks'))
    .input(metadataSchema)
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.orgMembership!.organizationId;
      const baseSlug = await uniqueFrameworkSlug(ctx, organizationId, input.name);
      const framework = await (ctx.prisma as any).customFramework.create({
        data: {
          organizationId,
          name: input.name,
          slug: baseSlug,
          description: input.description ?? null,
          jurisdiction: input.jurisdiction ?? null,
          regulator: input.regulator ?? null,
          category: input.category ?? null,
          createdByUserId: ctx.user!.id,
        },
      });
      await audit(ctx, 'custom_framework.created', framework.id, { organizationId });
      return framework;
    }),

  updateMetadata: orgMemberProcedureWithRole(managerRoles)
    .use(withPlanContext)
    .use(requirePlanFeature('customFrameworks'))
    .input(metadataSchema.partial().extend({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.orgMembership!.organizationId;
      const framework = await getFrameworkOrThrow(ctx, input.id, organizationId);
      assertDraft(framework);
      const updated = await (ctx.prisma as any).customFramework.update({
        where: { id: input.id },
        data: {
          name: input.name ?? undefined,
          description: input.description,
          jurisdiction: input.jurisdiction,
          regulator: input.regulator,
          category: input.category,
          updatedByUserId: ctx.user!.id,
        },
      });
      await audit(ctx, 'custom_framework.metadata_updated', input.id, { organizationId });
      return updated;
    }),

  createSection: orgMemberProcedureWithRole(managerRoles)
    .use(withPlanContext)
    .use(requirePlanFeature('customFrameworks'))
    .input(sectionSchema)
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.orgMembership!.organizationId;
      const framework = await getFrameworkOrThrow(ctx, input.frameworkId, organizationId);
      assertDraft(framework);
      const section = await (ctx.prisma as any).customFrameworkSection.create({
        data: { ...input, description: input.description ?? null, organizationId },
      });
      await audit(ctx, 'custom_framework.section_created', input.frameworkId, { organizationId, sectionId: section.id });
      return section;
    }),

  updateSection: orgMemberProcedureWithRole(managerRoles)
    .use(withPlanContext)
    .use(requirePlanFeature('customFrameworks'))
    .input(updateSectionSchema)
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.orgMembership!.organizationId;
      const section = await (ctx.prisma as any).customFrameworkSection.findFirst({ where: { id: input.id, organizationId } });
      if (!section) throw new TRPCError({ code: 'FORBIDDEN', message: 'Section not found or inaccessible.' });
      const framework = await getFrameworkOrThrow(ctx, section.frameworkId, organizationId);
      assertDraft(framework);
      const { id, ...data } = input;
      return (ctx.prisma as any).customFrameworkSection.update({ where: { id }, data });
    }),

  deleteSection: orgMemberProcedureWithRole(managerRoles)
    .use(withPlanContext)
    .use(requirePlanFeature('customFrameworks'))
    .input(idSchema)
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.orgMembership!.organizationId;
      const section = await (ctx.prisma as any).customFrameworkSection.findFirst({ where: { id: input.id, organizationId } });
      if (!section) throw new TRPCError({ code: 'FORBIDDEN', message: 'Section not found or inaccessible.' });
      const framework = await getFrameworkOrThrow(ctx, section.frameworkId, organizationId);
      assertDraft(framework);
      await (ctx.prisma as any).customFrameworkSection.delete({ where: { id: input.id } });
      await audit(ctx, 'custom_framework.section_deleted', section.frameworkId, { organizationId, sectionId: input.id });
      return { success: true };
    }),

  createControl: orgMemberProcedureWithRole(managerRoles)
    .use(withPlanContext)
    .use(requirePlanFeature('customFrameworks'))
    .input(controlSchema)
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.orgMembership!.organizationId;
      const framework = await getFrameworkOrThrow(ctx, input.frameworkId, organizationId);
      assertDraft(framework);
      if (input.sectionId && !framework.sections.some((section: { id: string }) => section.id === input.sectionId)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Section does not belong to this framework.' });
      }
      const control = await (ctx.prisma as any).customFrameworkControl.create({
        data: { ...input, evidenceRequired: input.evidenceRequired ?? undefined, organizationId },
      });
      await audit(ctx, 'custom_framework.control_created', input.frameworkId, { organizationId, controlId: control.id });
      return control;
    }),

  updateControl: orgMemberProcedureWithRole(managerRoles)
    .use(withPlanContext)
    .use(requirePlanFeature('customFrameworks'))
    .input(updateControlSchema)
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.orgMembership!.organizationId;
      const control = await (ctx.prisma as any).customFrameworkControl.findFirst({ where: { id: input.id, organizationId } });
      if (!control) throw new TRPCError({ code: 'FORBIDDEN', message: 'Control not found or inaccessible.' });
      const framework = await getFrameworkOrThrow(ctx, control.frameworkId, organizationId);
      assertDraft(framework);
      const { id, ...data } = input;
      return (ctx.prisma as any).customFrameworkControl.update({ where: { id }, data });
    }),

  deleteControl: orgMemberProcedureWithRole(managerRoles)
    .use(withPlanContext)
    .use(requirePlanFeature('customFrameworks'))
    .input(idSchema)
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.orgMembership!.organizationId;
      const control = await (ctx.prisma as any).customFrameworkControl.findFirst({ where: { id: input.id, organizationId } });
      if (!control) throw new TRPCError({ code: 'FORBIDDEN', message: 'Control not found or inaccessible.' });
      const framework = await getFrameworkOrThrow(ctx, control.frameworkId, organizationId);
      assertDraft(framework);
      await (ctx.prisma as any).customFrameworkControl.delete({ where: { id: input.id } });
      await audit(ctx, 'custom_framework.control_deleted', control.frameworkId, { organizationId, controlId: input.id });
      return { success: true };
    }),

  publish: orgMemberProcedureWithRole(managerRoles)
    .use(withPlanContext)
    .use(requirePlanFeature('customFrameworks'))
    .input(idSchema)
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.orgMembership!.organizationId;
      const framework = await getFrameworkOrThrow(ctx, input.id, organizationId);
      assertDraft(framework);
      if (framework.sections.length === 0 && framework.controls.length === 0) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Add at least one section or control before publishing.' });
      }
      const snapshot = {
        id: framework.id,
        name: framework.name,
        slug: framework.slug,
        description: framework.description,
        jurisdiction: framework.jurisdiction,
        regulator: framework.regulator,
        category: framework.category,
        version: framework.version,
        sections: framework.sections,
        controls: framework.controls,
      };
      await (ctx.prisma as any).customFrameworkVersion.create({
        data: { frameworkId: framework.id, organizationId, version: framework.version, snapshot, createdByUserId: ctx.user!.id },
      });
      const updated = await (ctx.prisma as any).customFramework.update({
        where: { id: framework.id },
        data: { status: 'PUBLISHED', publishedAt: new Date(), updatedByUserId: ctx.user!.id },
      });
      await audit(ctx, 'custom_framework.published', framework.id, { organizationId, version: framework.version });
      return updated;
    }),

  archive: orgMemberProcedureWithRole(managerRoles)
    .use(withPlanContext)
    .use(requirePlanFeature('customFrameworks'))
    .input(idSchema)
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.orgMembership!.organizationId;
      await getFrameworkOrThrow(ctx, input.id, organizationId);
      const archived = await (ctx.prisma as any).customFramework.update({
        where: { id: input.id },
        data: { status: 'ARCHIVED', archivedAt: new Date(), updatedByUserId: ctx.user!.id },
      });
      await audit(ctx, 'custom_framework.archived', input.id, { organizationId });
      return archived;
    }),

  getVersionHistory: orgMemberProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('customFrameworks'))
    .input(idSchema)
    .query(async ({ ctx, input }) => {
      const organizationId = ctx.orgMembership!.organizationId;
      await getFrameworkOrThrow(ctx, input.id, organizationId);
      return (ctx.prisma as any).customFrameworkVersion.findMany({
        where: { frameworkId: input.id, organizationId },
        select: { id: true, version: true, createdByUserId: true, createdAt: true },
        orderBy: { version: 'desc' },
      });
    }),
});

logger.debug({ type: 'custom_framework_router_loaded' });
