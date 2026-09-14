/**
 * Machine Lead Ingestion Service (P0)
 *
 * Implements idempotent batch ingestion for AI-discovered leads from n8n / automation runs.
 * Strictly separates AI observations (untrusted hints) from authoritative Company data.
 * Zero autonomous outbound: ends at leadStatus = PENDING_REVIEW or NURTURE.
 */

import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { NotFoundError } from '@/utils/error';
import {
  CompanyOrigin,
  LeadStatus,
  SalesStage,
  IcpTier,
  CompanySizeClass,
  EvidenceVerificationState,
  DiscoveryRunStatus,
} from '@prisma/client';
import {
  CandidateLeadInput,
  qualifyLead,
} from './lead-qualification.service';
import {
  findMatchingCompany,
  isExistingPayingCustomer,
  normalizeDomain,
} from './company-dedup.service';
import { ingestDiscoveryEvidence } from './company.service';
import {
  getDiscoverySources,
  updateDiscoverySourceState,
  type DiscoverySourceDefinition,
  type DiscoverySourceState,
  type UpdateDiscoverySourceStateInput,
} from './lead-discovery-sources';
import { llmGateway, getCurrentBudgetPeriod } from '@/lib/ai/gateway/llm-gateway';

// ---------------------------------------------------------------------------
// Types & Input Contracts
// ---------------------------------------------------------------------------

export interface IngestEvidenceItemInput {
  field: string;
  extractedValue: string;
  normalizedValue?: string | null;
  confidence?: number;
  sourceUrl: string;
  sourceAuthority?: string | null;
  sourceRecordId?: string | null;
  evidenceSnippet?: string | null;
  verificationState?: EvidenceVerificationState;
  extractionMethod?: string | null;
  modelProvider?: string | null;
  modelName?: string | null;
  extractorVersion?: string | null;
}

export interface IngestCandidateLeadInput extends CandidateLeadInput {
  primarySourceUrl: string;
  primarySourceAuthority?: string | null;
  evidence?: IngestEvidenceItemInput[];
}

export interface InitDiscoveryRunParams {
  runIdempotencyKey: string;
  workflowName?: string;
  sourceAuthority?: string | null;
  sourceUrl?: string | null;
  jurisdiction?: string;
  sourceSetId?: string;
  metadata?: Record<string, unknown>;
}

export interface IngestBatchParams {
  discoveryRunId: string;
  batchId: string;
  candidates: IngestCandidateLeadInput[];
  systemUserId?: string;
}

export interface CompleteDiscoveryRunParams {
  discoveryRunId: string;
  status?: DiscoveryRunStatus;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
}

export interface IngestBatchResult {
  discoveryRunId: string;
  batchId: string;
  totalProcessed: number;
  created: number;
  updated: number;
  matched: number;
  rejected: number;
  deduplicated: number;
  results: Array<{
    candidateName: string;
    companyId: string;
    action: 'CREATED' | 'UPDATED' | 'MATCHED' | 'REJECTED' | 'DUPLICATE';
    leadStatus: LeadStatus;
    leadScore: number | null;
    icpTier: IcpTier;
    reason?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getSystemUserId(): Promise<string> {
  const admin = await prisma.user.findFirst({
    where: { role: 'ADMIN', deletedAt: null },
    select: { id: true },
  });
  if (admin) return admin.id;

  const anyUser = await prisma.user.findFirst({
    where: { deletedAt: null },
    select: { id: true },
  });
  if (anyUser) return anyUser.id;

  throw new Error('No system user found to attribute machine lead creation');
}

// ---------------------------------------------------------------------------
// Service Implementation
// ---------------------------------------------------------------------------

export const leadIngestionService = {
  /**
   * Initializes or recovers an existing DiscoveryRun by idempotency key.
   */
  async initDiscoveryRun(params: InitDiscoveryRunParams) {
    const existing = await prisma.discoveryRun.findUnique({
      where: { runIdempotencyKey: params.runIdempotencyKey },
    });

    if (existing) {
      logger.info({
        type: 'discovery_run_resumed_idempotent',
        runId: existing.id,
        runIdempotencyKey: params.runIdempotencyKey,
      });
      return existing;
    }

    const sourceAuthority = params.sourceAuthority || 'KENYA_MULTI_REGULATORY_DISCOVERY';
    const sourceUrl = params.sourceUrl || 'https://sheriabot.com/lead-discovery';
    const runMetadata = {
      ...(params.metadata || {}),
      ...(params.jurisdiction ? { jurisdiction: params.jurisdiction } : {}),
      ...(params.sourceSetId ? { sourceSetId: params.sourceSetId } : {}),
    };

    const run = await prisma.discoveryRun.create({
      data: {
        runIdempotencyKey: params.runIdempotencyKey,
        workflowName: params.workflowName || 'W-SALES-LEADS-01',
        sourceAuthority,
        sourceUrl,
        status: DiscoveryRunStatus.RUNNING,
        metadata: runMetadata as any,
      },
    });

    logger.info({
      type: 'discovery_run_initialized',
      runId: run.id,
      workflow: run.workflowName,
      sourceAuthority: run.sourceAuthority,
      runIdempotencyKey: run.runIdempotencyKey,
    });

    return run;
  },

  /**
   * Processes a batch of candidate leads idempotently.
   */
  async ingestBatch(params: IngestBatchParams): Promise<IngestBatchResult> {
    const { discoveryRunId, batchId, candidates } = params;

    const run = await prisma.discoveryRun.findUnique({
      where: { id: discoveryRunId },
    });
    if (!run) throw new NotFoundError('DiscoveryRun not found');

    const systemUserId = params.systemUserId || (await getSystemUserId());

    let createdCount = 0;
    let updatedCount = 0;
    let matchedCount = 0;
    let rejectedCount = 0;
    let dedupCount = 0;

    const results: IngestBatchResult['results'] = [];

    for (const candidate of candidates) {
      const normDomain = normalizeDomain(candidate.domain);
      const country = candidate.country?.trim() || 'Kenya';

      // 1. Check if existing paying customer (Amendment 13: treat as commercial identity match)
      const isPayingCustomer = await isExistingPayingCustomer({
        domain: normDomain,
        name: candidate.name,
      });

      // 2. Multi-signal matching against existing Company records
      const matchResult = await findMatchingCompany({
        name: candidate.name,
        domain: normDomain,
        licenceNumber: candidate.licenceNumber,
        country,
      });

      // 3. Lead Qualification
      const qualification = qualifyLead({
        candidate,
        isExistingCustomer: isPayingCustomer,
      });

      let companyId: string;
      let action: 'CREATED' | 'UPDATED' | 'MATCHED' | 'REJECTED' | 'DUPLICATE';

      if (matchResult.matchedCompany) {
        // MATCHED / DUPLICATE
        companyId = matchResult.matchedCompany.id;
        const existingComp = matchResult.matchedCompany;

        // If existing company was legacy UNASSESSED or we have richer verified data, upgrade qualification
        const shouldUpdateQualification =
          existingComp.leadStatus === LeadStatus.UNASSESSED ||
          (qualification.score > (existingComp.leadScore || 0) && !isPayingCustomer);

        if (shouldUpdateQualification) {
          await prisma.company.update({
            where: { id: companyId },
            data: {
              leadStatus: qualification.leadStatus,
              icpTier: qualification.icpTier,
              leadScore: qualification.score,
              confidence: candidate.confidence ?? 0.8,
              lastVerifiedAt: new Date(),
              reviewReason: qualification.reviewReason || existingComp.reviewReason,
              licenceNumber: existingComp.licenceNumber || candidate.licenceNumber || null,
              licenceType: existingComp.licenceType || candidate.licenceType || null,
              licenceStatus: existingComp.licenceStatus || candidate.licenceStatus || null,
              regulatoryBody: existingComp.regulatoryBody || candidate.regulatoryBody || null,
            },
          });
          action = 'UPDATED';
          updatedCount++;
        } else {
          action = 'MATCHED';
          matchedCount++;
        }
        dedupCount++;
      } else {
        // NEW COMPANY
        const newCompany = await prisma.company.create({
          data: {
            name: candidate.name.trim(),
            domain: normDomain,
            industry: candidate.industry?.trim() || null,
            country,
            regulatoryBody: candidate.regulatoryBody?.trim() || null,
            licenceType: candidate.licenceType?.trim() || null,
            licenceNumber: candidate.licenceNumber?.trim() || null,
            licenceStatus: candidate.licenceStatus?.trim() || null,
            primarySourceUrl: candidate.primarySourceUrl?.trim() || null,
            primarySourceAuthority: candidate.primarySourceAuthority?.trim() || null,
            sizeClass: candidate.sizeClass || CompanySizeClass.UNKNOWN,
            origin: CompanyOrigin.AI_DISCOVERY,
            leadStatus: qualification.leadStatus,
            salesStage: SalesStage.PROSPECT,
            icpTier: qualification.icpTier,
            leadScore: qualification.score,
            confidence: candidate.confidence ?? 0.8,
            discoveredAt: new Date(),
            lastVerifiedAt: new Date(),
            reviewReason: qualification.reviewReason || null,
            rejectionReason: qualification.rejectionReason || null,
            createdById: systemUserId,
          },
        });
        companyId = newCompany.id;

        if (qualification.leadStatus === LeadStatus.REJECTED) {
          action = 'REJECTED';
          rejectedCount++;
        } else {
          action = 'CREATED';
          createdCount++;
        }
      }

      // 4. Ingest Evidence items idempotently
      const evidenceItems = candidate.evidence || [];
      // Always store primary source as evidence if no evidence array was explicitly passed
      if (evidenceItems.length === 0 && candidate.primarySourceUrl) {
        evidenceItems.push({
          field: 'REGULATORY_DIRECTORY_ENTRY',
          extractedValue: candidate.name,
          normalizedValue: candidate.name,
          confidence: candidate.confidence ?? 1.0,
          sourceUrl: candidate.primarySourceUrl,
          sourceAuthority: candidate.primarySourceAuthority || null,
          sourceRecordId: candidate.licenceNumber || null,
          verificationState: EvidenceVerificationState.UNVERIFIED,
          extractionMethod: 'AI_SCRAPE',
        });
      }

      for (const ev of evidenceItems) {
        await ingestDiscoveryEvidence({
          companyId,
          discoveryRunId,
          field: ev.field,
          extractedValue: ev.extractedValue,
          normalizedValue: ev.normalizedValue,
          confidence: ev.confidence,
          sourceUrl: ev.sourceUrl,
          sourceAuthority: ev.sourceAuthority,
          sourceRecordId: ev.sourceRecordId,
          evidenceSnippet: ev.evidenceSnippet,
          verificationState: ev.verificationState || EvidenceVerificationState.UNVERIFIED,
          extractionMethod: ev.extractionMethod,
          modelProvider: ev.modelProvider,
          modelName: ev.modelName,
          extractorVersion: ev.extractorVersion,
        });
      }

      // 5. Record DiscoveryRunCompany join record (Amendment 11)
      await prisma.discoveryRunCompany.upsert({
        where: {
          discoveryRunId_companyId: {
            discoveryRunId,
            companyId,
          },
        },
        create: {
          discoveryRunId,
          companyId,
          action,
          scoreAtRun: qualification.score,
          icpTierAtRun: qualification.icpTier,
          leadStatusAtRun: qualification.leadStatus,
          reason: qualification.reviewReason || qualification.rejectionReason || matchResult.matchType || null,
        },
        update: {
          action,
          scoreAtRun: qualification.score,
          icpTierAtRun: qualification.icpTier,
          leadStatusAtRun: qualification.leadStatus,
          reason: qualification.reviewReason || qualification.rejectionReason || matchResult.matchType || null,
        },
      });

      results.push({
        candidateName: candidate.name,
        companyId,
        action,
        leadStatus: qualification.leadStatus,
        leadScore: qualification.score,
        icpTier: qualification.icpTier,
        reason: qualification.reviewReason || qualification.rejectionReason,
      });
    }

    // 6. Update DiscoveryRun aggregate totals
    await prisma.discoveryRun.update({
      where: { id: discoveryRunId },
      data: {
        totalDiscovered: { increment: candidates.length },
        totalCreated: { increment: createdCount },
        totalUpdated: { increment: updatedCount },
        totalDeduplicated: { increment: dedupCount },
        totalRejected: { increment: rejectedCount },
        totalQualified: {
          increment: results.filter(
            (r) => r.leadStatus === LeadStatus.PENDING_REVIEW || r.leadStatus === LeadStatus.NURTURE
          ).length,
        },
      },
    });

    logger.info({
      type: 'discovery_batch_ingested',
      discoveryRunId,
      batchId,
      total: candidates.length,
      created: createdCount,
      updated: updatedCount,
      matched: matchedCount,
      rejected: rejectedCount,
    });

    return {
      discoveryRunId,
      batchId,
      totalProcessed: candidates.length,
      created: createdCount,
      updated: updatedCount,
      matched: matchedCount,
      rejected: rejectedCount,
      deduplicated: dedupCount,
      results,
    };
  },

  /**
   * Finalizes a DiscoveryRun.
   */
  async completeDiscoveryRun(params: CompleteDiscoveryRunParams) {
    const { discoveryRunId, status = DiscoveryRunStatus.COMPLETED, errorMessage, metadata } = params;

    const run = await prisma.discoveryRun.update({
      where: { id: discoveryRunId },
      data: {
        status,
        completedAt: new Date(),
        errorMessage: errorMessage || null,
        ...(metadata ? { metadata: metadata as any } : {}),
      },
    });

    logger.info({
      type: 'discovery_run_completed',
      runId: run.id,
      status: run.status,
      totalDiscovered: run.totalDiscovered,
      totalCreated: run.totalCreated,
      totalUpdated: run.totalUpdated,
    });

    return run;
  },

  /**
   * Returns discovery sources merged with their persistent execution state.
   */
  async getDiscoverySources(jurisdiction: string = 'KE'): Promise<DiscoverySourceDefinition[]> {
    return getDiscoverySources(jurisdiction);
  },

  /**
   * Updates persistent source state (fingerprint, cursor, outcome, failure counters).
   */
  async updateDiscoverySourceState(input: UpdateDiscoverySourceStateInput): Promise<DiscoverySourceState> {
    return updateDiscoverySourceState(input);
  },

  /**
   * Non-mutating read-only check of shared AI monthly budget and remaining spend.
   */
  async getBudgetStatus(period?: string) {
    const budgetPeriod = period || getCurrentBudgetPeriod();
    const status = await llmGateway.getMonthlyBudgetStatus(budgetPeriod);
    return {
      period: status.period,
      budgetUsd: status.budgetUsd,
      spentUsd: status.spentUsd,
      reservedUsd: status.reservedUsd,
      remainingUsd: status.remainingUsd,
      percentUsed: status.percentUsed,
      isHalted: status.remainingUsd <= 0,
      providers: status.providers,
    };
  },
};
