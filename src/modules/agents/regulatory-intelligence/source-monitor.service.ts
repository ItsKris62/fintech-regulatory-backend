import { BlogAuthorityType, BlogJurisdiction, BlogMonitoringMethod, BlogSourceType } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { AIRateLimiter } from '@/lib/ai/rate-limiter';
import { runSourceDiscoveryForMonitor } from '@/modules/blog-automation/source-discovery.service';
import { logger } from '@/utils/logger';
import type { SourceMonitorResult, UnverifiedSourceGap } from './types';

interface VerifiedSourceDefinition {
  sourceId: string;
  name: string;
  jurisdiction: BlogJurisdiction;
  countryLabel: string;
  authorityType: BlogAuthorityType;
  sourceType: BlogSourceType;
  monitoringMethod: BlogMonitoringMethod;
  baseUrl: string;
  feedUrl?: string;
  topics: string[];
  keywords: string[];
}

const VERIFIED_REGULATORY_SOURCES: readonly VerifiedSourceDefinition[] = [
  {
    sourceId: 'ke-cbk',
    name: 'Central Bank of Kenya',
    jurisdiction: 'KE',
    countryLabel: 'Kenya',
    authorityType: 'CENTRAL_BANK',
    sourceType: 'OFFICIAL',
    monitoringMethod: 'HTML_LISTING',
    baseUrl: 'https://www.centralbank.go.ke',
    topics: ['banking', 'payments', 'digital-credit', 'prudential'],
    keywords: ['cbk', 'central bank', 'payment', 'digital credit', 'prudential', 'guideline', 'circular'],
  },
  {
    sourceId: 'ke-odpc',
    name: 'Office of the Data Protection Commissioner',
    jurisdiction: 'KE',
    countryLabel: 'Kenya',
    authorityType: 'DATA_PROTECTION',
    sourceType: 'OFFICIAL',
    monitoringMethod: 'HTML_LISTING',
    baseUrl: 'https://www.odpc.go.ke',
    topics: ['data-protection', 'privacy'],
    keywords: ['odpc', 'data protection', 'privacy', 'guidance', 'registration'],
  },
  {
    sourceId: 'ke-cma',
    name: 'Capital Markets Authority Kenya',
    jurisdiction: 'KE',
    countryLabel: 'Kenya',
    authorityType: 'SECURITIES',
    sourceType: 'OFFICIAL',
    monitoringMethod: 'HTML_LISTING',
    baseUrl: 'https://www.cma.or.ke',
    topics: ['capital-markets', 'investments', 'securities'],
    keywords: ['cma', 'capital markets', 'securities', 'crowdfunding', 'digital assets'],
  },
  {
    sourceId: 'ke-ca',
    name: 'Communications Authority of Kenya',
    jurisdiction: 'KE',
    countryLabel: 'Kenya',
    authorityType: 'COMMUNICATIONS',
    sourceType: 'OFFICIAL',
    monitoringMethod: 'MANUAL',
    baseUrl: 'https://www.ca.go.ke',
    topics: ['communications', 'cybersecurity', 'ict'],
    keywords: ['communications authority', 'cybersecurity', 'ict', 'telecommunications'],
  },
  {
    sourceId: 'mw-rbm',
    name: 'Reserve Bank of Malawi',
    jurisdiction: 'MW',
    countryLabel: 'Malawi',
    authorityType: 'CENTRAL_BANK',
    sourceType: 'OFFICIAL',
    monitoringMethod: 'HTML_LISTING',
    baseUrl: 'https://www.rbm.mw/regulatorydocuments/',
    topics: ['banking', 'payments', 'microfinance'],
    keywords: ['reserve bank', 'payment', 'banking', 'microfinance', 'directive'],
  },
  {
    sourceId: 'mw-macra',
    name: 'Malawi Communications Regulatory Authority',
    jurisdiction: 'MW',
    countryLabel: 'Malawi',
    authorityType: 'COMMUNICATIONS',
    sourceType: 'OFFICIAL',
    monitoringMethod: 'MANUAL',
    baseUrl: 'https://macra.mw',
    topics: ['communications', 'ict', 'cybersecurity'],
    keywords: ['macra', 'communications', 'ict', 'cybersecurity'],
  },
  {
    sourceId: 'mw-fia',
    name: 'Financial Intelligence Authority Malawi',
    jurisdiction: 'MW',
    countryLabel: 'Malawi',
    authorityType: 'AML_CFT',
    sourceType: 'OFFICIAL',
    monitoringMethod: 'MANUAL',
    baseUrl: 'https://www.fia.gov.mw',
    topics: ['aml-cft'],
    keywords: ['financial intelligence', 'aml', 'cft', 'suspicious transaction'],
  },
  {
    sourceId: 'rw-bnr',
    name: 'National Bank of Rwanda',
    jurisdiction: 'RW',
    countryLabel: 'Rwanda',
    authorityType: 'CENTRAL_BANK',
    sourceType: 'OFFICIAL',
    monitoringMethod: 'HTML_LISTING',
    baseUrl: 'https://www.bnr.rw',
    topics: ['banking', 'payments', 'fintech'],
    keywords: ['national bank', 'payment', 'banking', 'fintech', 'regulation'],
  },
  {
    sourceId: 'rw-rura',
    name: 'Rwanda Utilities Regulatory Authority',
    jurisdiction: 'RW',
    countryLabel: 'Rwanda',
    authorityType: 'COMMUNICATIONS',
    sourceType: 'OFFICIAL',
    monitoringMethod: 'MANUAL',
    baseUrl: 'https://rura.rw',
    topics: ['communications', 'ict'],
    keywords: ['rura', 'communications', 'ict', 'telecom'],
  },
  {
    sourceId: 'rw-risa',
    name: 'Rwanda Information Society Authority',
    jurisdiction: 'RW',
    countryLabel: 'Rwanda',
    authorityType: 'COMMUNICATIONS',
    sourceType: 'OFFICIAL',
    monitoringMethod: 'MANUAL',
    baseUrl: 'https://www.risa.rw',
    topics: ['ict', 'cybersecurity'],
    keywords: ['risa', 'cybersecurity', 'ict', 'digital'],
  },
  {
    sourceId: 'rw-dppo',
    name: 'Rwanda Data Protection and Privacy Office',
    jurisdiction: 'RW',
    countryLabel: 'Rwanda',
    authorityType: 'DATA_PROTECTION',
    sourceType: 'OFFICIAL',
    monitoringMethod: 'MANUAL',
    baseUrl: 'https://dppo.gov.rw',
    topics: ['data-protection', 'privacy'],
    keywords: ['dppo', 'data protection', 'privacy'],
  },
  {
    sourceId: 'ng-cbn',
    name: 'Central Bank of Nigeria',
    jurisdiction: 'NG',
    countryLabel: 'Nigeria',
    authorityType: 'CENTRAL_BANK',
    sourceType: 'OFFICIAL',
    monitoringMethod: 'HTML_LISTING',
    baseUrl: 'https://www.cbn.gov.ng/documents/',
    topics: ['banking', 'payments', 'digital-lending', 'microfinance'],
    keywords: ['central bank', 'payment', 'banking', 'microfinance', 'circular', 'guideline'],
  },
  {
    sourceId: 'ng-ndpc',
    name: 'Nigeria Data Protection Commission',
    jurisdiction: 'NG',
    countryLabel: 'Nigeria',
    authorityType: 'DATA_PROTECTION',
    sourceType: 'OFFICIAL',
    monitoringMethod: 'MANUAL',
    baseUrl: 'https://ndpc.gov.ng',
    topics: ['data-protection', 'privacy'],
    keywords: ['ndpc', 'data protection', 'privacy'],
  },
  {
    sourceId: 'ng-sec',
    name: 'Securities and Exchange Commission Nigeria',
    jurisdiction: 'NG',
    countryLabel: 'Nigeria',
    authorityType: 'SECURITIES',
    sourceType: 'OFFICIAL',
    monitoringMethod: 'MANUAL',
    baseUrl: 'https://sec.gov.ng',
    topics: ['capital-markets', 'securities', 'digital-assets'],
    keywords: ['sec', 'securities', 'capital market', 'digital assets'],
  },
  {
    sourceId: 'ng-ncc',
    name: 'Nigerian Communications Commission',
    jurisdiction: 'NG',
    countryLabel: 'Nigeria',
    authorityType: 'COMMUNICATIONS',
    sourceType: 'OFFICIAL',
    monitoringMethod: 'MANUAL',
    baseUrl: 'https://ncc.gov.ng',
    topics: ['communications', 'ict'],
    keywords: ['ncc', 'communications', 'telecom', 'ict'],
  },
];

const UNVERIFIED_SOURCE_GAPS: readonly UnverifiedSourceGap[] = [
  {
    sourceId: 'mw-gazette',
    name: 'Malawi Legal Source / Gazette',
    jurisdiction: 'MW',
    regulatoryBody: 'GAZETTE',
    sourceUrl: null,
    reason: 'Source registry seed plan marks this source NEEDS_VERIFICATION; B3 must not auto-register or activate it.',
  },
  {
    sourceId: 'mw-data-protection',
    name: 'Malawi Data Protection/Privacy',
    jurisdiction: 'MW',
    regulatoryBody: 'DATA_PROTECTION',
    sourceUrl: null,
    reason: 'Source registry seed plan marks this source NEEDS_VERIFICATION; B3 must not auto-register or activate it.',
  },
  {
    sourceId: 'rw-gazette',
    name: 'Rwanda Official Gazette',
    jurisdiction: 'RW',
    regulatoryBody: 'GAZETTE',
    sourceUrl: null,
    reason: 'Source registry seed plan marks this source NEEDS_VERIFICATION; B3 must not auto-register or activate it.',
  },
  {
    sourceId: 'ng-gazette',
    name: 'Nigeria Official Legal/Gazette',
    jurisdiction: 'NG',
    regulatoryBody: 'GAZETTE',
    sourceUrl: null,
    reason: 'Source registry seed plan marks this source NEEDS_VERIFICATION; B3 must not auto-register or activate it.',
  },
];

interface BlogSourceMonitorRow {
  id: string;
  name: string;
  baseUrl: string;
  feedUrl: string | null;
  monitoringMethod: BlogMonitoringMethod;
  maxItemsPerRun: number;
  fetchTimeoutMs: number;
}

interface BlogSourceItemRow {
  id: string;
  monitorId: string;
  title: string;
  url: string;
  normalizedUrl: string;
  summary: string | null;
  jurisdiction: string;
  authorityType: string;
  sourceType: string;
  publicationDate: Date | null;
  discoveredAt: Date;
  contentHash: string;
  rawContentHash: string | null;
  monitor: { name: string };
}

interface BlogDiscoverySummary {
  status: string;
  itemsFound?: number;
  itemsCreated?: number;
  duplicateCount?: number;
  failureCount?: number;
  errorMessage?: string | null;
}

interface SourceMonitorPrisma {
  blogSourceMonitor: {
    upsert(args: object): Promise<BlogSourceMonitorRow>;
    findMany(args: object): Promise<BlogSourceMonitorRow[]>;
  };
  blogSourceItem: {
    findMany(args: object): Promise<BlogSourceItemRow[]>;
  };
}

export interface SourceMonitorDependencies {
  prisma?: SourceMonitorPrisma;
  discoveryRunner?: (params: { prisma: typeof defaultPrisma; monitorId: string; triggeredBy: 'SYSTEM' }) => Promise<BlogDiscoverySummary>;
  fetchRobots?: (url: string, timeoutMs: number) => Promise<string | null>;
  rateLimiterFactory?: (domain: string) => AIRateLimiter;
  now?: () => Date;
}

function domainFor(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

function robotsUrlFor(targetUrl: string): string {
  const url = new URL(targetUrl);
  return `${url.protocol}//${url.hostname}/robots.txt`;
}

function isPathAllowedByRobots(robots: string | null, targetUrl: string): boolean {
  if (!robots) return true;

  const path = new URL(targetUrl).pathname || '/';
  const lines = robots.split(/\r?\n/).map((line) => line.split('#')[0].trim()).filter(Boolean);
  let applies = false;
  const disallows: string[] = [];

  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (key === 'user-agent') {
      applies = value === '*' || value.toLowerCase().includes('sheriabot');
      continue;
    }

    if (applies && key === 'disallow' && value.length > 0) {
      disallows.push(value);
    }
  }

  return !disallows.some((rule) => path.startsWith(rule));
}

async function defaultFetchRobots(url: string, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(robotsUrlFor(url), {
      signal: controller.signal,
      headers: { 'User-Agent': 'SheriaBot-Regulatory-Monitor/1.0' },
    });
    if (!response.ok) return null;
    return await response.text();
  } catch (error: unknown) {
    logger.warn({ type: 'reg_intel_robots_fetch_failed', agentRunId: 'preflight', url, error: error instanceof Error ? error.message : String(error) });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export class SourceMonitorService {
  private readonly prisma: SourceMonitorPrisma;
  private readonly discoveryRunner: (params: { prisma: typeof defaultPrisma; monitorId: string; triggeredBy: 'SYSTEM' }) => Promise<BlogDiscoverySummary>;
  private readonly fetchRobots: (url: string, timeoutMs: number) => Promise<string | null>;
  private readonly rateLimiters = new Map<string, AIRateLimiter>();
  private readonly rateLimiterFactory: (domain: string) => AIRateLimiter;
  private readonly now: () => Date;

  constructor(dependencies: SourceMonitorDependencies = {}) {
    this.prisma = dependencies.prisma ?? (defaultPrisma as unknown as SourceMonitorPrisma);
    this.discoveryRunner = dependencies.discoveryRunner ?? ((params) => runSourceDiscoveryForMonitor(params));
    this.fetchRobots = dependencies.fetchRobots ?? defaultFetchRobots;
    this.rateLimiterFactory = dependencies.rateLimiterFactory ?? (() => new AIRateLimiter(6, 1));
    this.now = dependencies.now ?? (() => new Date());
  }

  getUnverifiedSourceGaps(): UnverifiedSourceGap[] {
    return [...UNVERIFIED_SOURCE_GAPS];
  }

  getVerifiedSourceDefinitions(): readonly VerifiedSourceDefinition[] {
    return VERIFIED_REGULATORY_SOURCES;
  }

  async ensureVerifiedMonitors(agentRunId: string): Promise<void> {
    for (const source of VERIFIED_REGULATORY_SOURCES) {
      await this.prisma.blogSourceMonitor.upsert({
        where: {
          jurisdiction_baseUrl: {
            jurisdiction: source.jurisdiction,
            baseUrl: source.baseUrl,
          },
        },
        create: {
          name: source.name,
          description: `Regulatory intelligence monitor seeded from verified B3 source ${source.sourceId}.`,
          jurisdiction: source.jurisdiction,
          countryLabel: source.countryLabel,
          authorityType: source.authorityType,
          sourceType: source.sourceType,
          monitoringMethod: source.monitoringMethod,
          baseUrl: source.baseUrl,
          feedUrl: source.feedUrl,
          topics: source.topics,
          keywords: source.keywords,
          status: source.monitoringMethod === 'MANUAL' ? 'INACTIVE' : 'ACTIVE',
          verificationStatus: 'VERIFIED',
          verifiedAt: this.now(),
          isActive: source.monitoringMethod !== 'MANUAL',
          isOfficial: true,
          notes: 'B3 verified source. Manual sources are registered but not activated for scraping.',
        },
        update: {
          name: source.name,
          countryLabel: source.countryLabel,
          authorityType: source.authorityType,
          sourceType: source.sourceType,
          monitoringMethod: source.monitoringMethod,
          feedUrl: source.feedUrl,
          topics: source.topics,
          keywords: source.keywords,
          verificationStatus: 'VERIFIED',
          status: source.monitoringMethod === 'MANUAL' ? 'INACTIVE' : 'ACTIVE',
          isActive: source.monitoringMethod !== 'MANUAL',
          notes: 'B3 verified source. Manual sources are registered but not activated for scraping.',
        },
      });
      logger.info({ type: 'reg_intel_source_registered', agentRunId, sourceId: source.sourceId, baseUrl: source.baseUrl });
    }
  }

  async scanSources(agentRunId: string): Promise<SourceMonitorResult> {
    const scanStartedAt = this.now();
    await this.ensureVerifiedMonitors(agentRunId);

    const monitors = await this.prisma.blogSourceMonitor.findMany({
      where: {
        verificationStatus: 'VERIFIED',
        status: 'ACTIVE',
        isActive: true,
        deletedAt: null,
        monitoringMethod: { in: ['RSS', 'HTML_LISTING'] },
      },
      orderBy: { createdAt: 'asc' },
    });

    const monitorSummaries: SourceMonitorResult['monitorSummaries'] = [];

    for (const monitor of monitors) {
      const targetUrl = monitor.feedUrl ?? monitor.baseUrl;
      const domain = domainFor(targetUrl);
      const limiter = this.getLimiter(domain);

      if (monitor.monitoringMethod === 'HTML_LISTING') {
        const robots = await this.fetchRobots(targetUrl, monitor.fetchTimeoutMs);
        if (!isPathAllowedByRobots(robots, targetUrl)) {
          logger.warn({ type: 'reg_intel_source_robots_blocked', agentRunId, monitorId: monitor.id, targetUrl });
          monitorSummaries.push({
            monitorId: monitor.id,
            name: monitor.name,
            status: 'SKIPPED_ROBOTS',
            itemsFound: 0,
            itemsCreated: 0,
            duplicateCount: 0,
            failureCount: 1,
            errorMessage: 'robots.txt disallows this HTML listing path',
          });
          continue;
        }
      }

      await limiter.acquire();
      try {
        logger.info({ type: 'reg_intel_source_discovery_started', agentRunId, monitorId: monitor.id, domain });
        const summary = await this.discoveryRunner({ prisma: defaultPrisma, monitorId: monitor.id, triggeredBy: 'SYSTEM' });
        monitorSummaries.push({
          monitorId: monitor.id,
          name: monitor.name,
          status: summary.status,
          itemsFound: summary.itemsFound ?? 0,
          itemsCreated: summary.itemsCreated ?? 0,
          duplicateCount: summary.duplicateCount ?? 0,
          failureCount: summary.failureCount ?? 0,
          errorMessage: summary.errorMessage ?? null,
        });
        logger.info({ type: 'reg_intel_source_discovered', agentRunId, monitorId: monitor.id, itemsCreated: summary.itemsCreated ?? 0 });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        monitorSummaries.push({
          monitorId: monitor.id,
          name: monitor.name,
          status: 'FAILED',
          itemsFound: 0,
          itemsCreated: 0,
          duplicateCount: 0,
          failureCount: 1,
          errorMessage: message,
        });
        logger.error({ type: 'reg_intel_source_discovery_failed', agentRunId, monitorId: monitor.id, error: message });
      } finally {
        limiter.release();
      }
    }

    const rows = await this.prisma.blogSourceItem.findMany({
      where: {
        discoveredAt: { gte: scanStartedAt },
        deletedAt: null,
        sourceType: 'OFFICIAL',
      },
      include: { monitor: { select: { name: true } } },
      orderBy: { discoveredAt: 'asc' },
    });

    return {
      items: rows.map((row) => ({
        id: row.id,
        monitorId: row.monitorId,
        title: row.title,
        url: row.url,
        normalizedUrl: row.normalizedUrl,
        summary: row.summary,
        jurisdiction: row.jurisdiction,
        authorityType: row.authorityType,
        sourceType: row.sourceType,
        publicationDate: row.publicationDate,
        discoveredAt: row.discoveredAt,
        contentHash: row.contentHash,
        rawContentHash: row.rawContentHash,
        monitorName: row.monitor.name,
      })),
      unverifiedSourceGaps: this.getUnverifiedSourceGaps(),
      monitorSummaries,
    };
  }

  private getLimiter(domain: string): AIRateLimiter {
    const existing = this.rateLimiters.get(domain);
    if (existing) return existing;
    const limiter = this.rateLimiterFactory(domain);
    this.rateLimiters.set(domain, limiter);
    return limiter;
  }
}

export const sourceMonitorService = new SourceMonitorService();