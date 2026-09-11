import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { parseJurisdictionFilter } from './duration';
import {
  RegulatorySnapshotService,
  RegulatoryItemService,
  RegulatoryAlertDraftService,
  RegulatoryFetchService,
  RegulatoryEnrichmentService,
  regulatorySnapshotService as defaultRegulatorySnapshotService,
  regulatoryItemService as defaultRegulatoryItemService,
  regulatoryAlertDraftService as defaultRegulatoryAlertDraftService,
  regulatoryFetchService as defaultRegulatoryFetchService,
  regulatoryEnrichmentService as defaultRegulatoryEnrichmentService,
} from '@/modules/regulatory-intelligence/domain';
import type {
  IngestRegulatorySnapshotInput,
  CreateRegulatorySourceItemInput,
  ListRegulatorySourceItemsInput,
  CreateRegulatoryAlertDraftInput,
  FetchRegulatorySourceInput,
  RegulatoryFetchResult,
  SnapshotIngestResult,
  ProcessRegulatorySnapshotMachineInput,
  ProcessRegulatorySnapshotResult,
} from '@/modules/regulatory-intelligence/domain/types';

export interface RegulatorySourceOperationalItem {
  id: string;
  sourceKey: string;
  name: string;
  jurisdictionCode: string;
  regulatoryBody: string;
  authorityType: string;
  sourceType: string;
  baseUrl: string;
  fetchUrl?: string;
  lastCheckedAt?: string;
}

export interface RegulatoryAutomationServiceDependencies {
  prisma?: typeof defaultPrisma;
  snapshotService?: RegulatorySnapshotService;
  itemService?: RegulatoryItemService;
  alertDraftService?: RegulatoryAlertDraftService;
  fetchService?: RegulatoryFetchService;
  enrichmentService?: RegulatoryEnrichmentService;
}

export class RegulatoryAutomationService {
  private readonly prisma: typeof defaultPrisma;
  private readonly snapshotService: RegulatorySnapshotService;
  private readonly itemService: RegulatoryItemService;
  private readonly alertDraftService: RegulatoryAlertDraftService;
  private readonly fetchService: RegulatoryFetchService;
  private readonly enrichmentService: RegulatoryEnrichmentService;

  constructor(dependencies: RegulatoryAutomationServiceDependencies = {}) {
    this.prisma = dependencies.prisma ?? defaultPrisma;
    this.snapshotService = dependencies.snapshotService ?? defaultRegulatorySnapshotService;
    this.itemService = dependencies.itemService ?? defaultRegulatoryItemService;
    this.alertDraftService = dependencies.alertDraftService ?? defaultRegulatoryAlertDraftService;
    this.fetchService = dependencies.fetchService ?? defaultRegulatoryFetchService;
    this.enrichmentService = dependencies.enrichmentService ?? defaultRegulatoryEnrichmentService;
  }

  /**
   * Machine procedure for W-REG-01 to query which sources to monitor.
   * Exposes only operational fields needed by workflow orchestration.
   */
  async listSources(input: { jurisdictions?: string; limit?: number }): Promise<{
    sources: RegulatorySourceOperationalItem[];
  }> {
    const requested = input.jurisdictions ? parseJurisdictionFilter(input.jurisdictions) : undefined;

    const sources = await this.prisma.regulatorySource.findMany({
      where: {
        isActive: true,
        ...(requested && requested.length > 0 ? { jurisdictionCode: { in: requested } } : {}),
      },
      orderBy: [{ jurisdictionCode: 'asc' }, { sourceKey: 'asc' }],
      take: input.limit ?? 50,
      select: {
        id: true,
        sourceKey: true,
        name: true,
        jurisdictionCode: true,
        regulatoryBody: true,
        authorityType: true,
        sourceType: true,
        baseUrl: true,
        fetchUrl: true,
        lastCheckedAt: true,
      },
    });

    return {
      sources: sources.map((s) => ({
        id: s.id,
        sourceKey: s.sourceKey,
        name: s.name,
        jurisdictionCode: s.jurisdictionCode,
        regulatoryBody: s.regulatoryBody,
        authorityType: s.authorityType,
        sourceType: s.sourceType,
        baseUrl: s.baseUrl,
        fetchUrl: s.fetchUrl ?? undefined,
        lastCheckedAt: s.lastCheckedAt?.toISOString(),
      })),
    };
  }

  /**
   * Machine procedure for W-REG-01 to safely fetch a regulatory source via the backend,
   * handling SSRF checks, ETag conditional caching, normalization, hashing, and snapshot persistence.
   */
  async fetchSource(input: FetchRegulatorySourceInput): Promise<RegulatoryFetchResult> {
    return this.fetchService.fetchAndIngestSource(input);
  }

  /**
   * Machine procedure for W-REG-01 to ingest immutable evidence snapshots.
   */
  async ingestSnapshot(input: IngestRegulatorySnapshotInput): Promise<SnapshotIngestResult> {
    return this.snapshotService.ingestSnapshot(input);
  }

  /**
   * Machine procedure for W-REG-03 to persist normalized regulatory intelligence items.
   */
  async createSourceItem(input: CreateRegulatorySourceItemInput) {
    const item = await this.itemService.createItem(input);
    return {
      id: item.id,
      dedupeKey: item.dedupeKey,
      jurisdictionCode: item.jurisdictionCode,
      regulator: item.regulator,
      title: item.title,
      informationType: item.informationType,
      regulatoryStage: item.regulatoryStage,
      materiality: item.materiality,
      createdAt: item.createdAt.toISOString(),
    };
  }

  /**
   * Machine procedure to fetch a single normalized regulatory item with evidence provenance.
   */
  async getSourceItem(input: { itemId: string }) {
    return this.itemService.getItem(input.itemId);
  }

  /**
   * Machine procedure to query recent normalized regulatory items.
   */
  async listSourceItems(input: ListRegulatorySourceItemsInput) {
    return this.itemService.listItems(input);
  }

  /**
   * Machine procedure to fetch a single snapshot by ID with trusted source relation.
   */
  async getSnapshot(input: { snapshotId: string }) {
    return this.snapshotService.getSnapshot(input.snapshotId);
  }

  /**
   * Machine procedure for W-REG-03 to enrich a regulatory snapshot and create an inactive draft.
   */
  async processSnapshot(input: ProcessRegulatorySnapshotMachineInput): Promise<ProcessRegulatorySnapshotResult> {
    return this.enrichmentService.processSnapshot(input);
  }

  /**
   * Machine procedure for W-REG-03 scheduled reconciliation to query pending snapshots.
   */
  async listPendingSnapshots(input: { limit?: number }) {
    return this.enrichmentService.listPendingSnapshots(input.limit ?? 10);
  }

  /**
   * Machine procedure for W-REG-03 to create an inactive draft RegulatoryAlert.
   * INVARIANT: Always creates isActive = false. Never publishes or notifies.
   */
  async createAlertDraft(input: CreateRegulatoryAlertDraftInput, agentUserId: string) {
    const { alert, isNew } = await this.alertDraftService.createAlertDraft(input, agentUserId);
    return {
      alertId: alert.id,
      title: alert.title,
      summary: alert.summary,
      jurisdictionCode: alert.jurisdictionCode,
      regulatoryBody: alert.regulatoryBody,
      category: alert.category,
      severity: alert.severity,
      isActive: alert.isActive, // MUST be false
      automationDraftKey: alert.automationDraftKey,
      primaryRegulatorySourceItemId: alert.primaryRegulatorySourceItemId,
      isNew,
    };
  }
}

export const regulatoryAutomationService = new RegulatoryAutomationService();
