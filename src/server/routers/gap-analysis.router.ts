import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { createHash } from 'crypto';
import { router, protectedProcedure, orgMemberProcedure } from '../trpc/trpc';
import { BillingMetric } from '@prisma/client';
import { rateLimited, withPlanContext, requirePlanFeature, resolveUsageLimit } from '../trpc/middleware';
import { requireEntitlementFeature } from '@/utils/entitlements';
import { PLAN_ENTITLEMENTS } from '@/config/entitlements.config';
import { complianceModule } from '@/modules/compliance';
import { logger } from '@/utils/logger';
import { NotFoundError, ForbiddenError } from '@/utils/error';
import { redis } from '@/lib/redis/client';
import {
  GAP_ANALYSIS_DEPTHS,
  GAP_ANALYSIS_DEPTH_UNIT_COST,
  GAP_ANALYSIS_FILE_EXTENSIONS,
  GAP_ANALYSIS_MAX_BASE64_CHARS,
  GAP_ANALYSIS_PROCESSING_ACK_VERSION,
  getGapAnalysisContract,
  getGapAnalysisFileExtension,
  isFrameworkDepthAvailable,
  getPilotFrameworkAvailability,
  getPilotJurisdictionAvailability,
  isGapAnalysisDepthAllowed,
} from '@/config/gap-analysis.config';
import { getCorpusVersionSnapshot } from '@/lib/rag/corpus-version';
import { getPineconeDiagnostics } from '@/lib/rag/client';
import {
  buildGapAnalysisExecutionIdentity,
  GAP_ANALYSIS_REUSABLE_EXECUTION_STATUSES,
} from '@/modules/compliance/gap-analysis-execution-identity';
import { GapAnalysisFileValidationError, validateGapAnalysisFile } from '@/lib/security/gap-analysis-file-validator';
import { scanGapAnalysisBuffer, MalwareDetectedError } from '@/lib/security/gap-analysis-malware';
import { validateAuthorizedBenchmarkDocumentIds } from '../services/benchmark-document.service';
import { canAccessFrameworkTier } from '../services/framework-access.service';
import {
  JURISDICTION_CODES,
  JurisdictionContractError,
  type JurisdictionContext,
} from '@/types/jurisdiction';
import {
  JurisdictionAuthorizationError,
  resolveJurisdictionEntitlement,
  toTrpcJurisdictionAuthorizationError,
} from '@/modules/jurisdiction/jurisdiction-entitlements';
import {
  getFrameworkMetadata,
  isFrameworkApplicableToJurisdiction,
} from '@/config/framework-metadata.config';

export const gapAnalysisRouter = router({
  /**
   * Return the list of regulatory frameworks available to the current user.
   * Each framework carries a `locked` flag when the framework's tier exceeds
   * the user's current subscription plan.
   *
   * @protected
   */
  getFrameworks: protectedProcedure
    .use(withPlanContext)
    .input(
      z
        .object({
          jurisdiction: z.enum(JURISDICTION_CODES).optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      if (!ctx.plan) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Your plan could not be resolved. Please contact support.',
        });
      }
      const plan = ctx.plan;

      const frameworks = await ctx.prisma.regulatoryFramework.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: { slug: true, name: true, category: true, description: true, tier: true },
      });

      return frameworks.map((fw) => {
        const meta = getFrameworkMetadata(fw.slug);
        const scope = meta?.scope ?? 'DOMESTIC';
        const jurisdictions = meta?.jurisdictions ?? ['KE'];
        const applicable = input?.jurisdiction
          ? isFrameworkApplicableToJurisdiction(fw.slug, input.jurisdiction)
          : true;
        const pilot = getPilotFrameworkAvailability(fw.slug, input?.jurisdiction);

        return {
          slug: fw.slug,
          name: fw.name,
          category: fw.category,
          description: fw.description,
          tier: fw.tier,
          locked: !canAccessFrameworkTier(plan, fw.tier),
          scope,
          jurisdictions,
          applicable,
          pilotEnabled: pilot.pilotEnabled,
          readiness: pilot.readiness,
        };
      });
    }),

  /**
   * Run a full AI+RAG gap analysis on an uploaded policy document.
   *
   * Security: organizationId is derived exclusively from ctx.orgMembership
   * (set by requireOrgMembership via orgMemberProcedure) and never from the
   * request body, closing the IDOR that allowed cross-tenant org attribution.
   * Dedup key uses v2 namespace keyed on userId to prevent cross-tenant cache
   * poisoning with the same file hash.
   *
   * @protected @org-member @rate-limited
   */
  runGapAnalysis: orgMemberProcedure
    .use(rateLimited('gapAnalysis', 5))
    .use(withPlanContext)
    .use(requirePlanFeature('gapAnalysis'))
    .input(
      z.object({
        fileName: z.string().min(1).max(255),
        fileType: z.enum(GAP_ANALYSIS_FILE_EXTENSIONS),
        fileContent: z.string().min(1).max(GAP_ANALYSIS_MAX_BASE64_CHARS),
        processingConsentAcknowledged: z.boolean().default(false),
        consentVersion: z.string().optional(),
        jurisdiction: z.enum(JURISDICTION_CODES).optional(),
        regulatoryFrameworks: z.array(z.string()).min(1).max(10),
        benchmarkDocumentIds: z.array(z.string().min(1)).max(10).optional(),
        analysisDepth: z.enum(GAP_ANALYSIS_DEPTHS).default('standard'),
        focusAreas: z.array(z.string()).max(10).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        // Enforce server-side data processing consent acknowledgement
        if (!input.processingConsentAcknowledged) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Data processing consent must be acknowledged before submitting a Gap Analysis.',
          });
        }
        // The optional client version is a stale-client concurrency check only.
        // It never becomes the authoritative audit version.
        if (
          input.consentVersion !== undefined &&
          input.consentVersion !== GAP_ANALYSIS_PROCESSING_ACK_VERSION
        ) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'The Gap Analysis processing acknowledgement has changed. Reload the page and review the current acknowledgement before submitting.',
          });
        }
        const effectiveConsentVersion = GAP_ANALYSIS_PROCESSING_ACK_VERSION;

        // RBAC: Regulators cannot run gap analyses on client documents
        if (ctx.user!.role === 'REGULATOR') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Regulators cannot run gap analyses on uploaded documents',
          });
        }

        if (ctx.user?.id) {
          const { section34RestrictionService } = await import('@/modules/user/restriction.service');
          const check = await section34RestrictionService.isProcessingPermitted(ctx.user.id, 'GAP_ANALYSIS');
          if (!check.permitted) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: check.reason ?? 'Gap analysis restricted pursuant to DPA Section 34',
            });
          }
        }

        if (!ctx.plan) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Your plan could not be resolved. Please contact support.',
          });
        }
        const plan = ctx.plan;
        const contract = getGapAnalysisContract(plan, ctx.entitlements);
        const benchmarkDocumentIds = [...new Set(input.benchmarkDocumentIds ?? [])];

        if (benchmarkDocumentIds.length > 0) {
          requireEntitlementFeature(
            ctx.entitlements ?? PLAN_ENTITLEMENTS[plan],
            'benchmarkDocuments',
          );
        }

        // Canonical Gap Analysis file contract. The extension and explicit
        // fileType must agree so a handcrafted request cannot bypass storage.
        const fileExtension = getGapAnalysisFileExtension(input.fileName);
        if (fileExtension !== input.fileType) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'The document filename and file type do not match.',
          });
        }
        const decodedBytes = Buffer.byteLength(input.fileContent, 'base64');
        if (contract.maxFileSizeBytes === 0) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Gap analysis file uploads are not available on your current plan.',
          });
        }
        if (decodedBytes > contract.maxFileSizeBytes) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `File exceeds the ${contract.maxFileSizeBytes / 1024 / 1024} MB Gap Analysis limit.`,
          });
        }

        // Strict Server-Side Content Inspection & Magic-Byte Validation
        const fileBuffer = Buffer.from(input.fileContent, 'base64');
        try {
          await validateGapAnalysisFile({
            fileName: input.fileName,
            fileType: input.fileType,
            buffer: fileBuffer,
          });
          logger.info({
            type: 'gap_analysis_upload_validated',
            userId: ctx.user!.id,
            orgId: ctx.orgMembership!.organizationId,
            fileType: input.fileType,
            fileSizeBytes: fileBuffer.length,
          });
        } catch (validationErr) {
          logger.warn({
            type: 'gap_analysis_file_rejected',
            userId: ctx.user!.id,
            orgId: ctx.orgMembership!.organizationId,
            safeExtension: input.fileType,
            failureClass: validationErr instanceof GapAnalysisFileValidationError
              ? validationErr.code ?? 'VALIDATION'
              : 'VALIDATION',
          });
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: (validationErr as Error).message,
          });
        }

        // Truthful Malware Scanning
        try {
          const scanResult = await scanGapAnalysisBuffer(fileBuffer, input.fileName);
          if (scanResult.status === 'clean' || scanResult.status === 'skipped') {
            logger.info({
              type: 'gap_analysis_malware_scan_passed',
              userId: ctx.user!.id,
              orgId: ctx.orgMembership!.organizationId,
              scannerStatus: scanResult.status,
              engine: scanResult.engine,
            });
          }
        } catch (scanErr) {
          logger.warn({
            type: 'gap_analysis_malware_scan_failed',
            userId: ctx.user!.id,
            orgId: ctx.orgMembership!.organizationId,
            safeExtension: input.fileType,
            failureClass: scanErr instanceof MalwareDetectedError ? 'INFECTED' : 'SCANNER_UNAVAILABLE',
          });
          if (scanErr instanceof MalwareDetectedError) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: scanErr.message,
            });
          }
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: (scanErr as Error).message,
          });
        }

        // Validate framework slugs and enforce tier access
        const dbFrameworks = await ctx.prisma.regulatoryFramework.findMany({
          where: { slug: { in: input.regulatoryFrameworks }, isActive: true },
          select: { id: true, slug: true, name: true, category: true, tier: true, sortOrder: true },
        });

        const foundSlugs = new Set(dbFrameworks.map((f) => f.slug));
        const invalidSlugs = input.regulatoryFrameworks.filter((s) => !foundSlugs.has(s));
        if (invalidSlugs.length > 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Invalid framework slug(s): ${invalidSlugs.join(', ')}`,
          });
        }
        const frameworksBySlug = new Map(dbFrameworks.map((framework) => [framework.slug, framework]));
        const orderedFrameworks = input.regulatoryFrameworks.map((slug) => frameworksBySlug.get(slug)!);

        const lockedFrameworks = orderedFrameworks.filter((f) => !canAccessFrameworkTier(plan, f.tier));
        if (lockedFrameworks.length > 0) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: `Your plan does not include access to: ${lockedFrameworks.map((f) => f.name).join(', ')}. Please upgrade.`,
          });
        }

        if (!isGapAnalysisDepthAllowed(plan, input.analysisDepth)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: `The ${input.analysisDepth} analysis depth is not available on the ${plan} plan. Allowed depths: ${contract.allowedDepths.join(', ') || 'none'}.`,
          });
        }

        // orgId is always session-derived -- never client-supplied (IDOR closed)
        const orgId   = ctx.orgMembership!.organizationId;
        const userId  = ctx.user!.id;
        const requestedJurisdiction = input.jurisdiction;
        let jurisdictionContext: JurisdictionContext;
        try {
          const entitlement = await resolveJurisdictionEntitlement({
            prisma: ctx.prisma as any,
            organizationId: orgId,
            effectivePlan: ctx.plan ?? 'REGULATOR',
            requestedMode: 'SINGLE',
            requestedJurisdictions: requestedJurisdiction ? [requestedJurisdiction] : undefined,
            source: requestedJurisdiction ? 'REQUEST' : 'LEGACY_DEFAULT',
            allowLegacyDefault: !requestedJurisdiction,
            audit: {
              userId,
              route: 'trpc.gapAnalysis.runGapAnalysis',
            },
          });
          jurisdictionContext = entitlement.jurisdictionContext;
          if (!requestedJurisdiction) {
            logger.warn({
              type: 'gap_analysis_deprecated_omitted_jurisdiction',
              userId,
              orgId,
              defaultedJurisdiction: entitlement.homeJurisdiction,
            });
          }
        } catch (error) {
          if (error instanceof JurisdictionContractError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error });
          }
          if (error instanceof JurisdictionAuthorizationError) throw toTrpcJurisdictionAuthorizationError(error);
          throw error;
        }

        const analysisJurisdiction = jurisdictionContext.mode === 'SINGLE'
          ? jurisdictionContext.primaryJurisdiction
          : 'KE';

        // Authoritative Pilot Availability Enforcement
        const jurisdictionAvailability = getPilotJurisdictionAvailability(analysisJurisdiction);
        if (!jurisdictionAvailability.pilotEnabled) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: jurisdictionAvailability.message || `Jurisdiction "${analysisJurisdiction}" is not currently enabled for Gap Analysis pilot testing.`,
          });
        }

        // Validate Framework Applicability against the authorized analysis jurisdiction
        for (const fw of orderedFrameworks) {
          if (!isFrameworkApplicableToJurisdiction(fw.slug, analysisJurisdiction)) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `Framework "${fw.name}" (${fw.slug}) is not applicable to jurisdiction ${analysisJurisdiction}.`,
            });
          }
          const fwPilot = getPilotFrameworkAvailability(fw.slug, analysisJurisdiction);
          if (!fwPilot.pilotEnabled) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: `Framework "${fw.name}" (${fw.slug}) is not enabled for Gap Analysis pilot testing in ${analysisJurisdiction}.`,
            });
          }
          if (!isFrameworkDepthAvailable(analysisJurisdiction, fw.slug, input.analysisDepth)) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: `${input.analysisDepth === 'deep' ? 'Deep Analysis' : `The ${input.analysisDepth} analysis depth`} is not yet validated for framework "${fw.name}" (${fw.slug}) in ${analysisJurisdiction}.`,
            });
          }
        }

        const frameworkNames = orderedFrameworks.map((f) => f.name);
        const frameworkSlugs = orderedFrameworks.map((f) => f.slug);

        const benchmarkDocuments = await validateAuthorizedBenchmarkDocumentIds({
          prisma: ctx.prisma as any,
          userId,
          organizationId: orgId,
          benchmarkDocumentIds,
        });

        const selectedBenchmarkDocuments = benchmarkDocuments.map((doc) => ({
          id: doc.id,
          title: doc.title,
          documentType: doc.documentType,
          regulatoryBody: doc.regulatoryBody ?? doc.source,
          authorityStatus: doc.authorityStatus,
          version: doc.version,
          isGlobal: doc.isGlobal,
        }));

        const documentChecksum = createHash('sha256').update(fileBuffer).digest('hex');
        const corpusVersions = await getCorpusVersionSnapshot(jurisdictionContext);
        const pinecone = getPineconeDiagnostics();
        const executionIdentity = buildGapAnalysisExecutionIdentity({
          organizationId: orgId,
          documentChecksum,
          jurisdictionCode: analysisJurisdiction,
          frameworkSlugs,
          benchmarkVersionIds: benchmarkDocuments.map((doc) => `${doc.id}:${doc.version ?? 'UNVERSIONED'}`),
          focusAreas: input.focusAreas ?? [],
          analysisDepth: input.analysisDepth,
          corpusVersions,
          pineconeIndex: pinecone.indexName,
          pineconeNamespace: pinecone.namespace,
        });

        const existingAnalysis = await ctx.tenantPrisma.gapAnalysis.findFirst({
          where: {
            executionIdentity: executionIdentity.key,
            organizationId: orgId,
            deletedAt: null,
            status: { in: [...GAP_ANALYSIS_REUSABLE_EXECUTION_STATUSES] },
          },
          orderBy: { createdAt: 'desc' },
        });
        if (existingAnalysis) {
          logger.info({ type: 'gap_analysis_dedupe_hit', userId, orgId, analysisId: existingAnalysis.id, status: existingAnalysis.status });
          return { ...existingAnalysis, reused: true };
        }

        // Resolve quota only after all request authorization and validation.
        // Paid-plan increments remain deferred until the analysis record exists;
        // the Free Trial path also avoids consuming units for rejected requests.
        const analysisUnits = GAP_ANALYSIS_DEPTH_UNIT_COST[input.analysisDepth];
        const usagePatch = await resolveUsageLimit(ctx, BillingMetric.GAP_ANALYSES, {
          deferIncrement: true,
          units: analysisUnits,
        });

        logger.info({
          type:       'gap_analysis_requested',
          userId,
          orgId,
          safeExtension: input.fileType,
          frameworks: input.regulatoryFrameworks,
          benchmarkDocumentIds,
          depth:      input.analysisDepth,
        });

        let usageReserved = false;
        let result: Awaited<ReturnType<typeof complianceModule.runGapAnalysis>>;
        try {
          // Reserve atomically before durable creation. A failed creation or a
          // race loser is compensated below; a canonical execution keeps one
          // reservation even if later non-critical response work fails.
          await usagePatch.incrementUsage?.();
          usageReserved = Boolean(usagePatch.incrementUsage);
          result = await complianceModule.runGapAnalysis(userId, {
            fileName:             input.fileName,
            fileType:             input.fileType,
            fileContent:          input.fileContent,
            regulatoryFrameworks: frameworkNames,
            regulatoryFrameworkSlugs: frameworkSlugs,
            benchmarkDocumentIds,
            benchmarkDocuments: selectedBenchmarkDocuments,
            analysisDepth:        input.analysisDepth,
            focusAreas:           input.focusAreas,
            organizationId:       orgId,
            jurisdictionContext,
            ipAddress:            ctx.req.ip,
            userAgent:            ctx.req.headers['user-agent'] as string | undefined,
            trialUserId:          ctx.plan === 'FREE_TRIAL' ? userId : undefined,
            consentVersion:       effectiveConsentVersion,
            documentChecksum,
            executionIdentity: executionIdentity.key,
            executionIdentityMetadata: executionIdentity.canonical,
          });
          if (result.reused && usageReserved) {
            await usagePatch.rollbackUsage?.();
            usageReserved = false;
          }
          if (!result.reused) {
            logger.info({ type: 'gap_analysis_created', userId, orgId, analysisId: result.id });
          }
        } catch (error) {
          if (usageReserved) await usagePatch.rollbackUsage?.();
          throw error;
        }

        // Record server-side consent audit log
        await ctx.prisma.auditLog.create({
          data: {
            userId,
            action: 'GAP_ANALYSIS_CONSENT_RECORDED',
            entityType: 'GapAnalysis',
            entityId: result.id,
            metadata: {
              analysisId: result.id,
              consentVersion: effectiveConsentVersion,
              acknowledgedAt: new Date().toISOString(),
              userId,
            },
            ipAddress: ctx.req.ip ?? null,
            userAgent: (ctx.req.headers['user-agent'] as string) ?? null,
          },
        }).catch((err: unknown) => {
          logger.error({ type: 'gap_analysis_consent_audit_failed', error: (err as Error).message });
        });

        await ctx.prisma.gapAnalysisFramework.createMany({
          data: orderedFrameworks.map((framework) => ({
            gapAnalysisId: result.id,
            frameworkId: framework.id,
            slug: framework.slug,
            name: framework.name,
            category: framework.category,
            tier: framework.tier,
            sortOrder: framework.sortOrder,
          })),
          skipDuplicates: true,
        });

        logger.info({ type: 'gap_analysis_request_success', userId, analysisId: result.id, status: result.status });
        return result;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to run gap analysis';
        logger.error({
          type: 'gap_analysis_request_error',
          userId: ctx.user!.id,
          failureClass: error instanceof TRPCError ? error.code : 'INTERNAL',
        });
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: msg, cause: error });
      }
    }),

  /**
   * List all gap analyses for the current user.
   *
   * @protected
   */
  getGapAnalyses: orgMemberProcedure
    .input(z.void())
    .query(async ({ ctx }) => {
      try {
        const analyses = await complianceModule.getUserGapAnalyses(
          ctx.user!.id,
          ctx.orgMembership!.organizationId,
        );
        logger.info({ type: 'gap_analysis_list_retrieved', userId: ctx.user!.id, count: analyses.length });
        return analyses;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to retrieve gap analyses';
        logger.error({ type: 'gap_analysis_list_error', userId: ctx.user!.id, error: msg });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: msg, cause: error });
      }
    }),

  /**
   * Minimal status projection for active polling. Full result JSON is fetched
   * only after the terminal COMPLETED transition.
   */
  getGapAnalysisStatus: orgMemberProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      const result = await ctx.tenantPrisma.gapAnalysis.findFirst({
        where: {
          id: input.id,
          organizationId: ctx.orgMembership!.organizationId,
          deletedAt: null,
        },
        select: {
          id: true,
          documentName: true,
          status: true,
          progress: true,
          overallScore: true,
          errorMessage: true,
        },
      });
      if (!result) throw new TRPCError({ code: 'NOT_FOUND', message: 'Gap analysis not found' });
      return result;
    }),

  /**
   * Get a specific gap analysis result by ID.
   *
   * @protected
   */
  getGapAnalysisResult: orgMemberProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      try {
        const result = await complianceModule.getGapAnalysisResult(
          ctx.user!.id,
          ctx.orgMembership!.organizationId,
          input.id,
          {
          ipAddress: ctx.req.ip,
          userAgent: ctx.req.headers['user-agent'] as string | undefined,
          },
        );
        logger.info({ type: 'gap_analysis_result_retrieved', userId: ctx.user!.id, analysisId: input.id });
        return result;
      } catch (error: unknown) {
        if (error instanceof NotFoundError) throw new TRPCError({ code: 'NOT_FOUND', message: error.message });
        if (error instanceof ForbiddenError) throw new TRPCError({ code: 'FORBIDDEN', message: error.message });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to retrieve gap analysis', cause: error });
      }
    }),

  /**
   * Returns the caller's per-tier gap analysis file size limit.
   */
  getGapAnalysisLimits: protectedProcedure
    .use(withPlanContext)
    .input(z.void())
    .query(({ ctx }) => {
      const plan = ctx.plan ?? 'REGULATOR';
      return getGapAnalysisContract(plan, ctx.entitlements);
    }),

  /**
   * Delete a gap analysis record and its R2 file.
   *
   * @protected
   */
  deleteGapAnalysis: orgMemberProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      try {
        await complianceModule.deleteGapAnalysis(
          ctx.user!.id,
          ctx.orgMembership!.organizationId,
          input.id,
          {
          ipAddress: ctx.req.ip,
          userAgent: ctx.req.headers['user-agent'] as string | undefined,
          },
        );
        logger.info({ type: 'gap_analysis_deleted', userId: ctx.user!.id, analysisId: input.id });
        return { success: true };
      } catch (error: unknown) {
        logger.error({
          type: 'gap_analysis_delete_error',
          userId: ctx.user!.id,
          analysisId: input.id,
          error: (error as Error).message,
        });
        if (error instanceof NotFoundError) throw new TRPCError({ code: 'NOT_FOUND', message: error.message });
        if (error instanceof ForbiddenError) throw new TRPCError({ code: 'FORBIDDEN', message: error.message });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to delete gap analysis', cause: error });
      }
    }),
});
