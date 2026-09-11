import { TRPCError } from '@trpc/server';
import { Prisma, RegulatoryEvidenceRole, RegulatoryStage, type RegulatorySourceItem } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import {
  createRegulatorySourceItemSchema,
  type CreateRegulatorySourceItemInput,
  type UpdateRegulatorySourceItemInput,
  type LinkEvidenceInput,
  type ListRegulatorySourceItemsInput,
} from './types';

export class RegulatoryItemService {
  constructor(private readonly prisma: typeof defaultPrisma = defaultPrisma) {}

  /**
   * Creates a normalized regulatory source item with database-backed deduplication.
   * Links primary snapshot evidence transactionally if provided.
   */
  async createItem(input: CreateRegulatorySourceItemInput): Promise<RegulatorySourceItem> {
    const data = createRegulatorySourceItemSchema.parse(input);
    const source = await this.prisma.regulatorySource.findUnique({
      where: { id: data.sourceId },
      select: { id: true },
    });

    if (!source) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `Regulatory source "${data.sourceId}" not found.`,
      });
    }

    if (data.primarySnapshotId) {
      const snapshot = await this.prisma.regulatorySourceSnapshot.findUnique({
        where: { id: data.primarySnapshotId },
        select: { id: true, sourceId: true },
      });

      if (!snapshot) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Primary snapshot "${data.primarySnapshotId}" not found.`,
        });
      }
    }

    // Check for dedupeKey conflict
    const existing = await this.prisma.regulatorySourceItem.findUnique({
      where: { dedupeKey: data.dedupeKey },
    });

    if (existing) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: `Regulatory item with dedupe key "${data.dedupeKey}" already exists (ID: ${existing.id}).`,
      });
    }

    const item = await this.prisma.$transaction(async (tx) => {
      const created = await tx.regulatorySourceItem.create({
        data: {
          dedupeKey: data.dedupeKey,
          sourceId: data.sourceId,
          primarySnapshotId: data.primarySnapshotId ?? null,
          jurisdictionCode: data.jurisdictionCode,
          regulator: data.regulator,
          title: data.title,
          officialTitle: data.officialTitle ?? null,
          summary: data.summary,
          informationType: data.informationType,
          regulatoryStage: data.regulatoryStage,
          verificationState: data.verificationState,
          materiality: data.materiality,
          relevanceScore: data.relevanceScore ?? null,
          publicationDate: data.publicationDate ? new Date(data.publicationDate) : null,
          effectiveDate: data.effectiveDate ? new Date(data.effectiveDate) : null,
          consultationDeadline: data.consultationDeadline ? new Date(data.consultationDeadline) : null,
          complianceDeadline: data.complianceDeadline ? new Date(data.complianceDeadline) : null,
          affectedSectors: (data.affectedSectors as Prisma.InputJsonValue) ?? [],
          affectedEntityTypes: (data.affectedEntityTypes as Prisma.InputJsonValue) ?? [],
          topics: (data.topics as Prisma.InputJsonValue) ?? [],
          metadata: (data.metadata as Prisma.InputJsonValue) ?? undefined,
        },
      });

      if (data.primarySnapshotId) {
        await tx.regulatorySourceItemEvidence.create({
          data: {
            sourceItemId: created.id,
            snapshotId: data.primarySnapshotId,
            role: RegulatoryEvidenceRole.PRIMARY,
            isPrimary: true,
          },
        });
      }

      return created;
    });

    logger.info({
      type: 'regulatory_item_created',
      itemId: item.id,
      dedupeKey: item.dedupeKey,
      jurisdiction: item.jurisdictionCode,
      regulator: item.regulator,
      informationType: item.informationType,
    });

    return item;
  }

  async updateItem(id: string, input: UpdateRegulatorySourceItemInput): Promise<RegulatorySourceItem> {
    const existing = await this.prisma.regulatorySourceItem.findUnique({ where: { id } });
    if (!existing) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Regulatory item not found.' });
    }

    const updated = await this.prisma.regulatorySourceItem.update({
      where: { id },
      data: {
        ...(input.title ? { title: input.title } : {}),
        ...(input.officialTitle !== undefined ? { officialTitle: input.officialTitle } : {}),
        ...(input.summary ? { summary: input.summary } : {}),
        ...(input.informationType ? { informationType: input.informationType } : {}),
        ...(input.regulatoryStage ? { regulatoryStage: input.regulatoryStage } : {}),
        ...(input.verificationState ? { verificationState: input.verificationState } : {}),
        ...(input.materiality ? { materiality: input.materiality } : {}),
        ...(input.relevanceScore !== undefined ? { relevanceScore: input.relevanceScore } : {}),
        ...(input.publicationDate !== undefined
          ? { publicationDate: input.publicationDate ? new Date(input.publicationDate) : null }
          : {}),
        ...(input.effectiveDate !== undefined
          ? { effectiveDate: input.effectiveDate ? new Date(input.effectiveDate) : null }
          : {}),
        ...(input.consultationDeadline !== undefined
          ? { consultationDeadline: input.consultationDeadline ? new Date(input.consultationDeadline) : null }
          : {}),
        ...(input.complianceDeadline !== undefined
          ? { complianceDeadline: input.complianceDeadline ? new Date(input.complianceDeadline) : null }
          : {}),
        ...(input.affectedSectors !== undefined ? { affectedSectors: input.affectedSectors as Prisma.InputJsonValue } : {}),
        ...(input.affectedEntityTypes !== undefined ? { affectedEntityTypes: input.affectedEntityTypes as Prisma.InputJsonValue } : {}),
        ...(input.topics !== undefined ? { topics: input.topics as Prisma.InputJsonValue } : {}),
        ...(input.supersededById !== undefined ? { supersededById: input.supersededById } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
        lastObservedAt: new Date(),
      },
    });

    logger.info({ type: 'regulatory_item_updated', itemId: id });
    return updated;
  }

  async getItem(id: string): Promise<RegulatorySourceItem> {
    const item = await this.prisma.regulatorySourceItem.findUnique({
      where: { id },
      include: {
        source: {
          select: { id: true, sourceKey: true, name: true, jurisdictionCode: true, regulatoryBody: true },
        },
        primarySnapshot: true,
        evidenceLinks: {
          include: {
            snapshot: {
              select: { id: true, canonicalUrl: true, contentHash: true, retrievedAt: true, title: true },
            },
          },
        },
        alerts: {
          select: { id: true, title: true, isActive: true, publishedAt: true, severity: true },
        },
        supersededBy: {
          select: { id: true, title: true, dedupeKey: true },
        },
      },
    });

    if (!item) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Regulatory item not found.' });
    }

    return item;
  }

  async getItemByDedupeKey(dedupeKey: string): Promise<RegulatorySourceItem | null> {
    return this.prisma.regulatorySourceItem.findUnique({ where: { dedupeKey } });
  }

  async listItems(input: ListRegulatorySourceItemsInput): Promise<{
    items: RegulatorySourceItem[];
    total: number;
  }> {
    const whereClause: Prisma.RegulatorySourceItemWhereInput = {
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      ...(input.jurisdictionCode ? { jurisdictionCode: input.jurisdictionCode } : {}),
      ...(input.regulator ? { regulator: input.regulator } : {}),
      ...(input.informationType ? { informationType: input.informationType } : {}),
      ...(input.regulatoryStage ? { regulatoryStage: input.regulatoryStage } : {}),
      ...(input.verificationState ? { verificationState: input.verificationState } : {}),
      ...(input.materiality ? { materiality: input.materiality } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.regulatorySourceItem.findMany({
        where: whereClause,
        orderBy: { createdAt: 'desc' },
        skip: input.offset,
        take: input.limit,
        include: {
          source: { select: { id: true, sourceKey: true, name: true } },
          _count: { select: { evidenceLinks: true, alerts: true } },
        },
      }),
      this.prisma.regulatorySourceItem.count({ where: whereClause }),
    ]);

    return { items, total };
  }

  /**
   * Links a snapshot to a regulatory source item.
   * Ensures at most ONE primary evidence relationship exists per item.
   */
  async linkEvidence(input: LinkEvidenceInput): Promise<void> {
    const [item, snapshot] = await Promise.all([
      this.prisma.regulatorySourceItem.findUnique({ where: { id: input.sourceItemId } }),
      this.prisma.regulatorySourceSnapshot.findUnique({ where: { id: input.snapshotId } }),
    ]);

    if (!item) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Regulatory item not found.' });
    }
    if (!snapshot) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Regulatory snapshot not found.' });
    }

    await this.prisma.$transaction(async (tx) => {
      if (input.isPrimary) {
        // Demote any existing primary evidence links
        await tx.regulatorySourceItemEvidence.updateMany({
          where: { sourceItemId: input.sourceItemId, isPrimary: true },
          data: { isPrimary: false },
        });

        await tx.regulatorySourceItem.update({
          where: { id: input.sourceItemId },
          data: { primarySnapshotId: input.snapshotId },
        });
      }

      await tx.regulatorySourceItemEvidence.upsert({
        where: {
          sourceItemId_snapshotId: {
            sourceItemId: input.sourceItemId,
            snapshotId: input.snapshotId,
          },
        },
        create: {
          sourceItemId: input.sourceItemId,
          snapshotId: input.snapshotId,
          role: input.role,
          isPrimary: input.isPrimary,
          notes: input.notes ?? null,
        },
        update: {
          role: input.role,
          isPrimary: input.isPrimary,
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        },
      });
    });

    logger.info({
      type: 'regulatory_item_evidence_linked',
      sourceItemId: input.sourceItemId,
      snapshotId: input.snapshotId,
      isPrimary: input.isPrimary,
      role: input.role,
    });
  }

  async markSuperseded(itemId: string, supersededById: string): Promise<RegulatorySourceItem> {
    const superseding = await this.prisma.regulatorySourceItem.findUnique({ where: { id: supersededById } });
    if (!superseding) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Superseding regulatory item not found.' });
    }

    return this.prisma.regulatorySourceItem.update({
      where: { id: itemId },
      data: {
        supersededById,
        regulatoryStage: RegulatoryStage.SUPERSEDED,
      },
    });
  }
}

export const regulatoryItemService = new RegulatoryItemService();
