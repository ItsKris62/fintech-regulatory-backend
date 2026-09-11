import { TRPCError } from '@trpc/server';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { safeFetch, validateSafeUrl } from '@/utils/safe-fetch';
import { canonicalizeUrl } from './canonical-url';
import {
  RegulatorySnapshotService,
  regulatorySnapshotService as defaultRegulatorySnapshotService,
} from './regulatory-snapshot.service';
import type {
  FetchRegulatorySourceInput,
  RegulatoryFetchResult,
} from './types';

export class RegulatoryFetchService {
  constructor(
    private readonly prisma: typeof defaultPrisma = defaultPrisma,
    private readonly snapshotService: RegulatorySnapshotService = defaultRegulatorySnapshotService
  ) {}

  /**
   * Safely fetches a configured RegulatorySource from authoritative DB configuration,
   * performs SSRF/security checks, conditional HTTP headers (ETag / 304),
   * content normalization, SHA-256 hash comparison, and atomic snapshot persistence.
   *
   * Updates source health metadata (lastCheckedAt, lastSuccessfulFetchAt, failureCount).
   */
  async fetchAndIngestSource(input: FetchRegulatorySourceInput): Promise<RegulatoryFetchResult> {
    // 1. Authoritative source lookup from DB
    const source = await this.prisma.regulatorySource.findFirst({
      where: {
        ...(input.sourceId ? { id: input.sourceId } : {}),
        ...(input.sourceKey ? { sourceKey: input.sourceKey } : {}),
      },
    });

    if (!source) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `Regulatory source not found (id: ${input.sourceId ?? 'none'}, key: ${input.sourceKey ?? 'none'}).`,
      });
    }

    if (!source.isActive) {
      return {
        status: 'SKIPPED',
        sourceId: source.id,
        sourceKey: source.sourceKey,
        error: 'Regulatory source is deactivated.',
        isNew: false,
      };
    }

    const targetUrl = source.fetchUrl || source.baseUrl;
    if (!targetUrl) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Regulatory source "${source.sourceKey}" has no valid fetchUrl or baseUrl.`,
      });
    }

    // 2. Resolve latest snapshot for conditional caching headers
    const latestSnapshot = await this.prisma.regulatorySourceSnapshot.findFirst({
      where: { sourceId: source.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        etag: true,
        lastModified: true,
        contentHash: true,
        canonicalUrl: true,
      },
    });

    const headers: Record<string, string> = {};
    if (latestSnapshot?.etag) {
      headers['If-None-Match'] = latestSnapshot.etag;
    }
    if (latestSnapshot?.lastModified) {
      headers['If-Modified-Since'] = latestSnapshot.lastModified;
    }

    const startTime = Date.now();

    try {
      // 3. Security validation at fetch time
      await validateSafeUrl(targetUrl);

      // 4. Safe fetch
      const fetchResponse = await safeFetch(targetUrl, {
        headers,
        timeoutMs: 15000,
        maxResponseBytes: 5 * 1024 * 1024, // 5MB limit
      });

      const durationMs = Date.now() - startTime;

      // 5. Handle 304 Not Modified
      if (fetchResponse.status === 304) {
        await this.prisma.regulatorySource.update({
          where: { id: source.id },
          data: {
            lastCheckedAt: new Date(),
            lastSuccessfulFetchAt: new Date(),
            failureCount: 0,
            lastFailureReason: null,
          },
        });

        logger.info({
          type: 'regulatory_source_fetch_304',
          sourceId: source.id,
          sourceKey: source.sourceKey,
          durationMs,
        });

        return {
          status: 'SUCCESS',
          changeType: 'UNCHANGED',
          sourceId: source.id,
          sourceKey: source.sourceKey,
          snapshotId: latestSnapshot?.id ?? null,
          canonicalUrl: canonicalizeUrl(targetUrl),
          httpStatus: 304,
          isNew: false,
        };
      }

      // 6. Non-2xx HTTP status handling
      if (fetchResponse.status < 200 || fetchResponse.status >= 300) {
        throw new Error(`HTTP ${fetchResponse.status} ${fetchResponse.statusText || 'Error'}`);
      }

      // 7. Normalize content and compute hash
      const rawPayload = await fetchResponse.text();
      const { normalizedText, contentHash } = this.snapshotService.normalizeAndHash(rawPayload);
      const canonicalUrl = canonicalizeUrl(targetUrl);

      // 8. Change detection: compare with latest snapshot
      if (latestSnapshot && latestSnapshot.contentHash === contentHash) {
        // UNCHANGED
        await this.prisma.regulatorySource.update({
          where: { id: source.id },
          data: {
            lastCheckedAt: new Date(),
            lastSuccessfulFetchAt: new Date(),
            failureCount: 0,
            lastFailureReason: null,
          },
        });

        logger.info({
          type: 'regulatory_source_fetch_unchanged',
          sourceId: source.id,
          sourceKey: source.sourceKey,
          contentHash,
          durationMs,
        });

        return {
          status: 'SUCCESS',
          changeType: 'UNCHANGED',
          sourceId: source.id,
          sourceKey: source.sourceKey,
          snapshotId: latestSnapshot.id,
          contentHash,
          canonicalUrl,
          httpStatus: fetchResponse.status,
          isNew: false,
        };
      }

      // 9. NEW or CHANGED -> Ingest Snapshot
      const changeType = latestSnapshot ? 'CHANGED' : 'NEW';

      const ingestResult = await this.snapshotService.ingestSnapshot({
        sourceId: source.id,
        sourceUrl: targetUrl,
        rawPayload,
        rawText: normalizedText,
        httpStatus: fetchResponse.status,
        contentType: fetchResponse.headers.get('content-type') ?? 'text/html',
        etag: fetchResponse.headers.get('etag') ?? undefined,
        lastModified: fetchResponse.headers.get('last-modified') ?? undefined,
        metadata: {
          ...input.executionMetadata,
          durationMs,
          changeType,
        },
      });

      // Update source health
      await this.prisma.regulatorySource.update({
        where: { id: source.id },
        data: {
          lastCheckedAt: new Date(),
          lastSuccessfulFetchAt: new Date(),
          failureCount: 0,
          lastFailureReason: null,
        },
      });

      logger.info({
        type: 'regulatory_source_fetch_success',
        sourceId: source.id,
        sourceKey: source.sourceKey,
        changeType,
        snapshotId: ingestResult.snapshotId,
        contentHash,
        durationMs,
      });

      return {
        status: 'SUCCESS',
        changeType,
        sourceId: source.id,
        sourceKey: source.sourceKey,
        snapshotId: ingestResult.snapshotId,
        contentHash,
        canonicalUrl: ingestResult.canonicalUrl,
        httpStatus: fetchResponse.status,
        isNew: true,
      };
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Record failure atomically
      try {
        await this.prisma.regulatorySource.update({
          where: { id: source.id },
          data: {
            lastCheckedAt: new Date(),
            lastFailureAt: new Date(),
            lastFailureReason: errorMessage.slice(0, 1000),
            failureCount: { increment: 1 },
          },
        });
      } catch (dbErr) {
        logger.error({ type: 'regulatory_source_update_failed', error: dbErr });
      }

      logger.warn({
        type: 'regulatory_source_fetch_failed',
        sourceId: source.id,
        sourceKey: source.sourceKey,
        error: errorMessage,
        durationMs,
      });

      return {
        status: 'FAILED',
        sourceId: source.id,
        sourceKey: source.sourceKey,
        error: errorMessage,
        httpStatus: error?.status ?? 500,
        isNew: false,
      };
    }
  }

  /**
   * Admin test connection action: tests URL reachability and latency without persisting snapshots.
   */
  async testConnection(sourceId: string): Promise<{
    ok: boolean;
    httpStatus: number;
    latencyMs: number;
    contentType?: string;
    previewText?: string;
    error?: string;
  }> {
    const source = await this.prisma.regulatorySource.findUnique({
      where: { id: sourceId },
    });

    if (!source) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `Regulatory source "${sourceId}" not found.`,
      });
    }

    const targetUrl = source.fetchUrl || source.baseUrl;
    const start = Date.now();

    try {
      await validateSafeUrl(targetUrl);
      const res = await safeFetch(targetUrl, {
        timeoutMs: 10000,
        maxResponseBytes: 1024 * 1024,
      });

      const latencyMs = Date.now() - start;
      const text = await res.text();
      const previewText = text.slice(0, 500);

      return {
        ok: res.status >= 200 && res.status < 400,
        httpStatus: res.status,
        latencyMs,
        contentType: res.headers.get('content-type') || undefined,
        previewText,
      };
    } catch (err: any) {
      return {
        ok: false,
        httpStatus: err?.status ?? 500,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export const regulatoryFetchService = new RegulatoryFetchService();
