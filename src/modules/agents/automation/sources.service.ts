import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { BlogJurisdiction } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { stripHtml } from '@/utils/helpers';
import { parseJurisdictionFilter } from './duration';

const GET_SOURCES_MAX_ITEMS = 50;
const FETCH_TIMEOUT_MS = 8000;
const FETCH_MAX_CONTENT_CHARS = 200_000;

const BLOG_JURISDICTION_SET: ReadonlySet<string> = new Set(Object.values(BlogJurisdiction));

function isBlogJurisdiction(value: string): value is BlogJurisdiction {
  return BLOG_JURISDICTION_SET.has(value);
}

/**
 * BlogSourceItem.jurisdiction is a strict Postgres enum (KE|MW|RW|NG|REGIONAL|
 * GLOBAL) - it does NOT accept free-text country names. Elsewhere in this
 * codebase (BlogPost.jurisdiction) the convention is a free-text default
 * ("Kenya") - the two conventions coexist and are NOT interchangeable. This
 * validates a single jurisdiction value used for a filter/write against the
 * strict enum, throwing a clear error rather than silently matching nothing.
 */
function requireBlogJurisdiction(value: string): BlogJurisdiction {
  if (!isBlogJurisdiction(value)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Unrecognized jurisdiction "${value}". Expected one of: ${[...BLOG_JURISDICTION_SET].join(', ')}.`,
    });
  }
  return value;
}

type SourcesPrisma = Pick<typeof defaultPrisma, 'blogSourceItem'>;

type FetchLike = typeof fetch;

export interface AutomationSourcesServiceDependencies {
  prisma?: SourcesPrisma;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export interface SourceListItem {
  id: string;
  url: string;
  title: string;
  summary?: string;
  publicationDate?: string;
  jurisdiction: string;
  regulator?: string;
}

export class AutomationSourcesService {
  private readonly prisma: SourcesPrisma;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  constructor(dependencies: AutomationSourcesServiceDependencies = {}) {
    this.prisma = dependencies.prisma ?? (defaultPrisma as unknown as SourcesPrisma);
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.now = dependencies.now ?? (() => new Date());
  }

  /**
   * `regulator` maps from BlogSourceItem.publisher - the closest existing
   * field (the publishing authority's name); there is no field literally
   * named "regulator" on this model. Flagging the rename per the brief's own
   * instruction to call out any field-name deviation.
   */
  async getSources(input: { jurisdictions: string }): Promise<{ sources: SourceListItem[] }> {
    const requested = parseJurisdictionFilter(input.jurisdictions) ?? [];
    const validJurisdictions = requested.filter(isBlogJurisdiction);

    if (requested.length > 0 && validJurisdictions.length === 0) {
      logger.warn({ type: 'automation_get_sources_no_valid_jurisdictions', requested });
      return { sources: [] };
    }

    const items = await this.prisma.blogSourceItem.findMany({
      where: {
        deletedAt: null,
        ...(validJurisdictions.length > 0 ? { jurisdiction: { in: validJurisdictions } } : {}),
      },
      orderBy: { discoveredAt: 'desc' },
      take: GET_SOURCES_MAX_ITEMS,
      select: { id: true, url: true, title: true, summary: true, publicationDate: true, jurisdiction: true, publisher: true },
    });

    return {
      sources: items.map((item) => ({
        id: item.id,
        url: item.url,
        title: item.title,
        summary: item.summary ?? undefined,
        publicationDate: item.publicationDate?.toISOString(),
        jurisdiction: item.jurisdiction,
        regulator: item.publisher ?? undefined,
      })),
    };
  }

  /**
   * Pure fetch + normalize - no DB write. `sourceId` is accepted (per the
   * brief's input shape) but not used to update any BlogSourceItem row: the
   * brief describes this procedure only as "fetch and normalize", with no
   * output shape or persistence behavior specified, so writing to an existing
   * row here would be inventing a side effect that isn't asked for.
   */
  async fetchSource(input: { url: string; sourceId: string; jurisdiction: string }): Promise<{
    sourceId: string;
    normalizedContent: string;
    contentHash: string;
    fetchedAt: string;
  }> {
    requireBlogJurisdiction(input.jurisdiction);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let rawContent: string;
    try {
      const response = await this.fetchImpl(input.url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'SheriaBot-Automation/1.0' },
      });
      if (!response.ok) {
        throw new TRPCError({ code: 'BAD_GATEWAY', message: `Fetching ${input.url} failed with HTTP ${response.status}.` });
      }
      rawContent = await response.text();
    } catch (error: unknown) {
      if (error instanceof TRPCError) throw error;
      logger.warn({ type: 'automation_fetch_source_failed', sourceId: input.sourceId, url: input.url, error: error instanceof Error ? error.message : String(error) });
      throw new TRPCError({ code: 'BAD_GATEWAY', message: `Failed to fetch ${input.url}: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      clearTimeout(timeout);
    }

    const normalizedContent = stripHtml(rawContent).replace(/\s+/g, ' ').trim().slice(0, FETCH_MAX_CONTENT_CHARS);
    const contentHash = createHash('sha256').update(normalizedContent).digest('hex');
    const fetchedAt = this.now().toISOString();

    logger.info({ type: 'automation_fetch_source_completed', sourceId: input.sourceId, url: input.url, contentLength: normalizedContent.length });
    return { sourceId: input.sourceId, normalizedContent, contentHash, fetchedAt };
  }

  /**
   * Jurisdiction-scoped read, per the brief's own note that the same hash can
   * be legitimately new in one jurisdiction and already-seen in another.
   * Caveat: BlogSourceItem.contentHash carries a GLOBAL @@unique constraint
   * (not scoped by jurisdiction) - this read answers correctly regardless,
   * but if the same contentHash genuinely needs to exist for two different
   * jurisdictions, a future INSERT of the second one will be rejected by that
   * constraint. That's a pre-existing schema/business-rule mismatch, not
   * something this read-only procedure introduces or fixes.
   */
  async dedupeSource(input: { contentHash: string; jurisdiction: string }): Promise<{ isNew: boolean }> {
    const jurisdiction = requireBlogJurisdiction(input.jurisdiction);

    const existing = await this.prisma.blogSourceItem.findFirst({
      where: { contentHash: input.contentHash, jurisdiction },
      select: { id: true },
    });

    return { isNew: !existing };
  }
}

export const automationSourcesService = new AutomationSourcesService();
