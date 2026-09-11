import { TRPCError } from '@trpc/server';
import type { Prisma, RegulatorySource } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { validateSafeUrl } from '@/utils/safe-fetch';
import {
  createRegulatorySourceSchema,
  type CreateRegulatorySourceInput,
  type UpdateRegulatorySourceInput,
  type ListRegulatorySourcesInput,
} from './types';

export class RegulatorySourceService {
  constructor(private readonly prisma: typeof defaultPrisma = defaultPrisma) {}

  /**
   * Admin-controlled creation of a new regulatory source monitor.
   * Validates URLs at creation time against SSRF protections.
   */
  async createSource(input: CreateRegulatorySourceInput): Promise<RegulatorySource> {
    const data = createRegulatorySourceSchema.parse(input);
    await validateSafeUrl(data.baseUrl);
    if (data.fetchUrl) {
      await validateSafeUrl(data.fetchUrl);
    }

    const existing = await this.prisma.regulatorySource.findUnique({
      where: { sourceKey: data.sourceKey },
    });

    if (existing) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: `Regulatory source with key "${data.sourceKey}" already exists.`,
      });
    }

    const source = await this.prisma.regulatorySource.create({
      data: {
        sourceKey: data.sourceKey,
        name: data.name,
        jurisdictionCode: data.jurisdictionCode,
        regulatoryBody: data.regulatoryBody,
        authorityType: data.authorityType,
        sourceType: data.sourceType,
        baseUrl: data.baseUrl,
        fetchUrl: data.fetchUrl ?? null,
        isActive: data.isActive,
        metadata: (data.metadata as Prisma.InputJsonValue) ?? undefined,
      },
    });

    logger.info({
      type: 'regulatory_source_created',
      sourceId: source.id,
      sourceKey: source.sourceKey,
      jurisdiction: source.jurisdictionCode,
      regulatoryBody: source.regulatoryBody,
    });

    return source;
  }

  /**
   * Admin-controlled update of a regulatory source.
   */
  async updateSource(id: string, input: UpdateRegulatorySourceInput): Promise<RegulatorySource> {
    const existing = await this.prisma.regulatorySource.findUnique({ where: { id } });
    if (!existing) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Regulatory source not found.' });
    }

    if (input.baseUrl) {
      await validateSafeUrl(input.baseUrl);
    }
    if (input.fetchUrl) {
      await validateSafeUrl(input.fetchUrl);
    }

    const updated = await this.prisma.regulatorySource.update({
      where: { id },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.jurisdictionCode ? { jurisdictionCode: input.jurisdictionCode } : {}),
        ...(input.regulatoryBody ? { regulatoryBody: input.regulatoryBody } : {}),
        ...(input.authorityType ? { authorityType: input.authorityType } : {}),
        ...(input.sourceType ? { sourceType: input.sourceType } : {}),
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        ...(input.fetchUrl !== undefined ? { fetchUrl: input.fetchUrl } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
      },
    });

    logger.info({ type: 'regulatory_source_updated', sourceId: id });
    return updated;
  }

  async getSource(id: string): Promise<RegulatorySource> {
    const source = await this.prisma.regulatorySource.findUnique({
      where: { id },
      include: {
        _count: {
          select: { snapshots: true, items: true },
        },
      },
    });

    if (!source) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Regulatory source not found.' });
    }

    return source;
  }

  async getSourceByKey(sourceKey: string): Promise<RegulatorySource | null> {
    return this.prisma.regulatorySource.findUnique({ where: { sourceKey } });
  }

  async listSources(input: ListRegulatorySourcesInput): Promise<{
    sources: RegulatorySource[];
    total: number;
  }> {
    const whereClause: Prisma.RegulatorySourceWhereInput = {
      ...(input.jurisdictionCode ? { jurisdictionCode: input.jurisdictionCode } : {}),
      ...(input.regulatoryBody ? { regulatoryBody: input.regulatoryBody } : {}),
      ...(input.authorityType ? { authorityType: input.authorityType } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    };

    const [sources, total] = await Promise.all([
      this.prisma.regulatorySource.findMany({
        where: whereClause,
        orderBy: [{ jurisdictionCode: 'asc' }, { name: 'asc' }],
        skip: input.offset,
        take: input.limit,
      }),
      this.prisma.regulatorySource.count({ where: whereClause }),
    ]);

    return { sources, total };
  }

  async deactivateSource(id: string): Promise<RegulatorySource> {
    return this.prisma.regulatorySource.update({
      where: { id },
      data: { isActive: false },
    });
  }

  async recordFetchResult(
    id: string,
    result: { success: boolean; error?: string; timestamp?: Date }
  ): Promise<void> {
    const ts = result.timestamp ?? new Date();

    if (result.success) {
      await this.prisma.regulatorySource.update({
        where: { id },
        data: {
          lastCheckedAt: ts,
          lastSuccessfulFetchAt: ts,
          failureCount: 0,
          lastFailureReason: null,
        },
      });
    } else {
      await this.prisma.regulatorySource.update({
        where: { id },
        data: {
          lastCheckedAt: ts,
          lastFailureAt: ts,
          failureCount: { increment: 1 },
          lastFailureReason: result.error ? result.error.slice(0, 2000) : 'Unknown error',
        },
      });
    }
  }
}

export const regulatorySourceService = new RegulatorySourceService();
