import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from './client';

/**
 * Enumeration of all models in schema.prisma that have a tenant-isolation field
 * (orgId or organizationId). Total: 39 models.
 */
export const TENANT_MODEL_FIELD_MAP: Record<string, 'orgId' | 'organizationId'> = {
  User: 'organizationId',
  SecurityAuditEvent: 'organizationId',
  Policy: 'organizationId',
  LegalDocument: 'organizationId',
  ComplianceQuery: 'organizationId',
  RegulatoryApplication: 'organizationId',
  Checklist: 'organizationId',
  GapAnalysis: 'organizationId',
  UsageMetric: 'organizationId',
  AnalyticsEvent: 'orgId',
  Invitation: 'organizationId',
  ComplianceItem: 'organizationId',
  ComplianceScoreSnapshot: 'organizationId',
  UsageRecord: 'organizationId',
  PilotAccess: 'organizationId',
  CustomFramework: 'organizationId',
  CustomFrameworkSection: 'organizationId',
  CustomFrameworkControl: 'organizationId',
  CustomFrameworkVersion: 'organizationId',
  EnterpriseContract: 'organizationId',
  EnterprisePlanOverride: 'organizationId',
  UsagePeriod: 'organizationId',
  Payment: 'orgId',
  ComplianceEvent: 'organizationId',
  License: 'organizationId',
  LicenseTimelineEvent: 'organizationId',
  LicenseDocument: 'organizationId',
  LicenseFee: 'organizationId',
  VaultDocument: 'organizationId',
  AiJob: 'organizationId',
  AlertSubscription: 'organizationId',
  AlertNotification: 'organizationId',
  GeneratedPolicy: 'organizationId',
  GeneratedPolicyExportLog: 'organizationId',
  OrganizationMember: 'organizationId',
  CorpusGapFeedback: 'organizationId',
  CorpusGapReport: 'organizationId',
  AgentRun: 'organizationId',
  SalesOutreachDraft: 'organizationId',
};

export type TenantScopedPrismaClient = ReturnType<typeof createTenantScopedPrisma>;

/**
 * Creates a tenant-scoped Prisma client extension.
 * Opt-in per-request wrapper that enforces tenant isolation by injecting orgId
 * into all read, write, update, and delete queries for tenant-scoped models.
 */
export function createTenantScopedPrisma(
  basePrisma: any = defaultPrisma,
  orgId?: string | null
) {
  return basePrisma.$extends({
    name: 'tenant-scope-extension',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: {
          model?: string;
          operation: string;
          args: any;
          query: (args: any) => Promise<any>;
        }) {
          if (!model) {
            return query(args);
          }

          const fieldName = TENANT_MODEL_FIELD_MAP[model];
          // If not a tenant-scoped model, allow untouched execution (e.g. SystemConfig, Organization)
          if (!fieldName) {
            return query(args);
          }

          // Strict tenancy validation: orgId must be present
          if (!orgId || typeof orgId !== 'string' || orgId.trim() === '') {
            throw new Error(
              `Tenant context error: orgId is missing from context for tenant-scoped model "${model}"`
            );
          }

          const currentArgs = args ? { ...args } : {};

          // Read operations: inject orgId into where clause
          if (
            operation === 'findMany' ||
            operation === 'findFirst' ||
            operation === 'findFirstOrThrow' ||
            operation === 'count' ||
            operation === 'aggregate' ||
            operation === 'groupBy'
          ) {
            currentArgs.where = {
              ...(currentArgs.where ?? {}),
              [fieldName]: orgId,
            };
            return query(currentArgs);
          }

          // findUnique / findUniqueOrThrow: translate to findFirst with orgId boundary
          // to prevent cross-tenant lookup by ID or unique key
          if (operation === 'findUnique') {
            return (basePrisma[model] as any).findFirst({
              ...currentArgs,
              where: {
                ...(currentArgs.where ?? {}),
                [fieldName]: orgId,
              },
            });
          }

          if (operation === 'findUniqueOrThrow') {
            return (basePrisma[model] as any).findFirstOrThrow({
              ...currentArgs,
              where: {
                ...(currentArgs.where ?? {}),
                [fieldName]: orgId,
              },
            });
          }

          // Create: inject orgId into data
          if (operation === 'create') {
            currentArgs.data = {
              ...(currentArgs.data ?? {}),
              [fieldName]: orgId,
            };
            return query(currentArgs);
          }

          // createMany / createManyAndReturn: inject orgId into all items
          if (operation === 'createMany' || operation === 'createManyAndReturn') {
            if (Array.isArray(currentArgs.data)) {
              currentArgs.data = currentArgs.data.map((item: any) => ({
                ...(item ?? {}),
                [fieldName]: orgId,
              }));
            } else if (currentArgs.data) {
              currentArgs.data = {
                ...currentArgs.data,
                [fieldName]: orgId,
              };
            }
            return query(currentArgs);
          }

          // updateMany / deleteMany: inject orgId into where
          if (operation === 'updateMany' || operation === 'deleteMany') {
            currentArgs.where = {
              ...(currentArgs.where ?? {}),
              [fieldName]: orgId,
            };
            return query(currentArgs);
          }

          // update / delete: verify existing record belongs to tenant before mutating
          if (operation === 'update' || operation === 'delete') {
            const existing = await (basePrisma[model] as any).findFirst({
              where: {
                ...(currentArgs.where ?? {}),
                [fieldName]: orgId,
              },
              select: { id: true },
            });

            if (!existing) {
              throw new Error(
                `Record not found or access denied for tenant scope "${orgId}" in model "${model}"`
              );
            }

            return query(currentArgs);
          }

          // upsert: ensure both create and update payload + where belong to tenant
          if (operation === 'upsert') {
            currentArgs.create = {
              ...(currentArgs.create ?? {}),
              [fieldName]: orgId,
            };
            currentArgs.update = {
              ...(currentArgs.update ?? {}),
              [fieldName]: orgId,
            };

            const existing = await (basePrisma[model] as any).findFirst({
              where: {
                ...(currentArgs.where ?? {}),
                [fieldName]: orgId,
              },
              select: { id: true },
            });

            if (!existing) {
              const anyTenantRecord = await (basePrisma[model] as any).findFirst({
                where: currentArgs.where,
                select: { id: true },
              });
              if (anyTenantRecord) {
                throw new Error(
                  `Record exists under another tenant scope; access denied for upsert in model "${model}"`
                );
              }
            }

            return query(currentArgs);
          }

          return query(currentArgs);
        },
      },
    },
  });
}
