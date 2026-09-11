import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import type { Prisma, RegulatorySourceSnapshot } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { stripHtml } from '@/utils/helpers';
import { canonicalizeUrl } from './canonical-url';
import type { IngestRegulatorySnapshotInput, SnapshotIngestResult } from './types';

export const HASH_VERSION = 1;
export const NORMALIZATION_VERSION = 1;

export class RegulatorySnapshotService {
  constructor(private readonly prisma: typeof defaultPrisma = defaultPrisma) {}

  /**
   * Computes normalized text and versioned SHA-256 hash.
   */
  normalizeAndHash(rawPayload: string): { normalizedText: string; contentHash: string } {
    const stripped = stripHtml(rawPayload);
    const normalizedText = stripped.replace(/\s+/g, ' ').trim();
    const contentHash = createHash('sha256').update(normalizedText, 'utf8').digest('hex');
    return { normalizedText, contentHash };
  }

  /**
   * Ingests an immutable regulatory source snapshot with DB-level deduplication.
   * Concurrency-safe against race conditions via DB unique constraint [sourceId, canonicalUrl, contentHash].
   */
  async ingestSnapshot(input: IngestRegulatorySnapshotInput): Promise<SnapshotIngestResult> {
    const source = await this.prisma.regulatorySource.findUnique({
      where: { id: input.sourceId },
      select: { id: true, sourceKey: true, isActive: true },
    });

    if (!source) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `Regulatory source "${input.sourceId}" not found.`,
      });
    }

    const canonicalUrl = canonicalizeUrl(input.sourceUrl);
    const contentToNormalize = input.rawText ?? input.rawPayload ?? input.title ?? '';
    const { normalizedText, contentHash } = this.normalizeAndHash(contentToNormalize);

    // 1. Pre-check for duplicate snapshot
    const existing = await this.prisma.regulatorySourceSnapshot.findUnique({
      where: {
        sourceId_canonicalUrl_contentHash: {
          sourceId: input.sourceId,
          canonicalUrl,
          contentHash,
        },
      },
      select: { id: true },
    });

    if (existing) {
      logger.info({
        type: 'regulatory_snapshot_duplicate',
        sourceId: input.sourceId,
        canonicalUrl,
        contentHash,
        snapshotId: existing.id,
      });

      await this.prisma.regulatorySource.update({
        where: { id: input.sourceId },
        data: { lastCheckedAt: new Date() },
      });

      return {
        status: 'DUPLICATE',
        snapshotId: existing.id,
        sourceId: input.sourceId,
        canonicalUrl,
        contentHash,
        isNew: false,
      };
    }

    // 2. Insert new immutable snapshot (with P2002 race protection)
    let snapshot: RegulatorySourceSnapshot;
    try {
      snapshot = await this.prisma.regulatorySourceSnapshot.create({
        data: {
          sourceId: input.sourceId,
          sourceUrl: input.sourceUrl,
          canonicalUrl,
          contentHash,
          hashVersion: HASH_VERSION,
          normalizationVersion: NORMALIZATION_VERSION,
          contentLength: normalizedText.length,
          httpStatus: input.httpStatus ?? null,
          contentType: input.contentType ?? null,
          etag: input.etag ?? null,
          lastModified: input.lastModified ?? null,
          rawText: input.rawText ?? normalizedText,
          rawPayload: input.rawPayload ?? null,
          rawStorageKey: input.rawStorageKey ?? null,
          title: input.title ?? null,
          metadata: (input.metadata as Prisma.InputJsonValue) ?? undefined,
        },
      });
    } catch (error: unknown) {
      // Handle race condition where another concurrent execution created the exact same snapshot
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code: string }).code === 'P2002'
      ) {
        const concurrent = await this.prisma.regulatorySourceSnapshot.findUnique({
          where: {
            sourceId_canonicalUrl_contentHash: {
              sourceId: input.sourceId,
              canonicalUrl,
              contentHash,
            },
          },
          select: { id: true },
        });

        if (concurrent) {
          return {
            status: 'DUPLICATE',
            snapshotId: concurrent.id,
            sourceId: input.sourceId,
            canonicalUrl,
            contentHash,
            isNew: false,
          };
        }
      }
      throw error;
    }

    // 3. Update source last-checked & last-successful metadata
    await this.prisma.regulatorySource.update({
      where: { id: input.sourceId },
      data: {
        lastCheckedAt: new Date(),
        lastSuccessfulFetchAt: new Date(),
        failureCount: 0,
      },
    });

    logger.info({
      type: 'regulatory_snapshot_created',
      snapshotId: snapshot.id,
      sourceId: snapshot.sourceId,
      canonicalUrl,
      contentHash,
      contentLength: snapshot.contentLength,
    });

    return {
      status: 'CREATED',
      snapshotId: snapshot.id,
      sourceId: snapshot.sourceId,
      canonicalUrl,
      contentHash,
      isNew: true,
    };
  }

  async getSnapshot(id: string): Promise<RegulatorySourceSnapshot> {
    const snapshot = await this.prisma.regulatorySourceSnapshot.findUnique({
      where: { id },
      include: {
        source: {
          select: { id: true, sourceKey: true, name: true, jurisdictionCode: true, regulatoryBody: true },
        },
      },
    });

    if (!snapshot) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Regulatory source snapshot not found.' });
    }

    return snapshot;
  }

  async listSnapshotsForSource(sourceId: string, limit = 50): Promise<RegulatorySourceSnapshot[]> {
    return this.prisma.regulatorySourceSnapshot.findMany({
      where: { sourceId },
      orderBy: { retrievedAt: 'desc' },
      take: limit,
    });
  }
}

export const regulatorySnapshotService = new RegulatorySnapshotService();
