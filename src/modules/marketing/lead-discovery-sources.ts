/**
 * Lead Discovery Source Registry & Persistent State Manager (P1)
 *
 * Provides authoritative server-side definitions for Kenyan regulatory lead discovery sources
 * and manages persistent source state (fingerprints, cursors, consecutive failures) in Redis.
 */

import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';

export interface DiscoverySourceDefinition {
  sourceId: string;
  name: string;
  authority: string;
  jurisdiction: 'KE';
  sourceType: 'REGULATORY_REGISTER' | 'REGULATORY_DIRECTORY' | 'GOVERNMENT_NOTICE';
  contentAdapter: 'PDF_TABULAR' | 'HTML_TABLE' | 'JSON_API' | 'CSV';
  targetSegment: string;
  landingPageUrl: string;
  resolvedDocumentUrl: string;
  resolvedSourceUrl?: string;
  documentTitle?: string;
  trustTier: 'OFFICIAL_REGULATOR' | 'GOVERNMENT_GAZETTE' | 'OFFICIAL_COMPANY';
  maxRecords: number;
  enabled: boolean;
  concurrencyLimit: number;
  retryPolicy: {
    maxRetries: number;
    backoffMs: number;
  };
  lastReviewedDate: string;
  notes?: string;
  // Merged dynamic persistent state
  state?: DiscoverySourceState;
}

export interface DiscoverySourceState {
  sourceId: string;
  lastSuccessfulFingerprint?: string | null;
  lastSuccessfulAt?: string | null;
  lastProcessedCursor?: string | null;
  lastRecordIdentifier?: string | null;
  lastSourceVersion?: string | null;
  lastResult?: 'SUCCESS' | 'FAILED' | 'SKIPPED_UNCHANGED' | null;
  consecutiveFailures: number;
  updatedAt: string;
  persistenceStatus?: 'REDIS_PERSISTED' | 'DEGRADED_UNPERSISTED';
  metadata?: Record<string, unknown>;
}

export interface UpdateDiscoverySourceStateInput {
  sourceId: string;
  contentFingerprint?: string | null;
  processedCursor?: string | null;
  recordIdentifier?: string | null;
  sourceVersion?: string | null;
  result: 'SUCCESS' | 'FAILED' | 'SKIPPED_UNCHANGED';
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
}

export interface DynamicResolutionResult {
  resolvedUrl: string;
  documentTitle: string;
  publicationDate?: string;
  sourceVersion?: string;
}

/**
 * Dynamically resolves the latest official CBK Digital Credit Provider directory
 * from the CBK landing page HTML, selecting the newest document by publication date.
 */
export function resolveCbkDcpDocumentFromHtml(landingPageHtml: string): DynamicResolutionResult {
  const defaultFallback: DynamicResolutionResult = {
    resolvedUrl: 'https://www.centralbank.go.ke/wp-content/uploads/2026/08/Directory-of-Digital-Credit-Providers-August-2026.pdf',
    documentTitle: 'Directory of Licensed Digital Credit Providers (Updated August 2026)',
    publicationDate: '2026-08-14',
    sourceVersion: '2026-08',
  };

  if (!landingPageHtml || typeof landingPageHtml !== 'string') {
    return defaultFallback;
  }

  // Regex to find PDF links matching DCP directory on centralbank.go.ke
  const linkRegex = /<a\s+[^>]*href=["']([^"']*(?:centralbank\.go\.ke|\/wp-content)[^"']*(?:Digital-Credit-Providers|directory-of-digital-credit|dcp)[^"']*\.pdf)["'][^>]*>(.*?)<\/a>/gi;
  const candidates: Array<{ url: string; text: string; dateWeight: number; dateStr?: string }> = [];

  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(landingPageHtml)) !== null) {
    let url = match[1];
    if (url.startsWith('/')) {
      url = `https://www.centralbank.go.ke${url}`;
    }
    const linkText = match[2].replace(/<[^>]+>/g, '').trim();

    // Extract date weight from URL YYYY/MM (e.g. 2026/08 -> 202608)
    const urlDateMatch = url.match(/\/(\d{4})\/(\d{2})\//);
    let dateWeight = 0;
    let dateStr: string | undefined;

    if (urlDateMatch) {
      const year = parseInt(urlDateMatch[1], 10);
      const month = parseInt(urlDateMatch[2], 10);
      dateWeight = year * 100 + month;
      dateStr = `${year}-${String(month).padStart(2, '0')}`;
    }

    // Check link text for month/year (e.g. "August 2026", "14 August 2026")
    const textYearMatch = linkText.match(/20\d{2}/);
    if (textYearMatch) {
      const textYear = parseInt(textYearMatch[0], 10);
      if (textYear * 100 > dateWeight) {
        dateWeight = textYear * 100;
        dateStr = `${textYear}`;
      }
    }

    candidates.push({ url, text: linkText, dateWeight, dateStr });
  }

  if (candidates.length === 0) {
    return defaultFallback;
  }

  // Sort descending by dateWeight
  candidates.sort((a, b) => b.dateWeight - a.dateWeight);
  const selected = candidates[0];

  return {
    resolvedUrl: selected.url,
    documentTitle: selected.text ? `Directory of Licensed Digital Credit Providers (${selected.text})` : defaultFallback.documentTitle,
    publicationDate: selected.dateStr || defaultFallback.publicationDate,
    sourceVersion: selected.dateStr || defaultFallback.sourceVersion,
  };
}

/**
 * Authoritative Canonical Source Definitions for Kenya
 */
export const KENYA_DISCOVERY_SOURCES: DiscoverySourceDefinition[] = [
  {
    sourceId: 'KE-SRC-CBK-DCP',
    name: 'CBK Digital Credit Providers Directory',
    authority: 'Central Bank of Kenya',
    jurisdiction: 'KE',
    sourceType: 'REGULATORY_REGISTER',
    contentAdapter: 'PDF_TABULAR',
    targetSegment: 'Digital Lenders, Consumer Credit Fintechs',
    landingPageUrl: 'https://www.centralbank.go.ke/policy-procedures/credit-providers/',
    resolvedDocumentUrl: 'https://www.centralbank.go.ke/wp-content/uploads/2026/08/Directory-of-Digital-Credit-Providers-August-2026.pdf',
    resolvedSourceUrl: 'https://www.centralbank.go.ke/wp-content/uploads/2026/08/Directory-of-Digital-Credit-Providers-August-2026.pdf',
    documentTitle: 'Directory of Licensed Digital Credit Providers (Updated August 2026)',
    trustTier: 'OFFICIAL_REGULATOR',
    maxRecords: 60,
    enabled: true,
    concurrencyLimit: 2,
    retryPolicy: {
      maxRetries: 3,
      backoffMs: 2000,
    },
    lastReviewedDate: '2026-09-14',
    notes: 'Primary high-conversion target: licensed Kenyan DCPs with mandatory AML/CFT & DPA reporting obligations.',
  },
  {
    sourceId: 'KE-SRC-CBK-PSP',
    name: 'CBK Payment Service Providers Register',
    authority: 'Central Bank of Kenya',
    jurisdiction: 'KE',
    sourceType: 'REGULATORY_REGISTER',
    contentAdapter: 'HTML_TABLE',
    targetSegment: 'Payment Gateways, Remittance, E-Money Operators',
    landingPageUrl: 'https://www.centralbank.go.ke/national-payments-system/payment-service-providers/',
    resolvedDocumentUrl: 'https://www.centralbank.go.ke/national-payments-system/payment-service-providers/',
    resolvedSourceUrl: 'https://www.centralbank.go.ke/national-payments-system/payment-service-providers/',
    documentTitle: 'Authorized Payment Service Providers in Kenya (NPS Act)',
    trustTier: 'OFFICIAL_REGULATOR',
    maxRecords: 40,
    enabled: true,
    concurrencyLimit: 2,
    retryPolicy: {
      maxRetries: 3,
      backoffMs: 2000,
    },
    lastReviewedDate: '2026-09-14',
    notes: 'High-value B2B payment companies requiring continuous regulatory monitoring.',
  },
  {
    sourceId: 'KE-SRC-SASRA-SACCO',
    name: 'SASRA Regulated SACCOs Directory',
    authority: 'SASRA Kenya',
    jurisdiction: 'KE',
    sourceType: 'REGULATORY_REGISTER',
    contentAdapter: 'HTML_TABLE',
    targetSegment: 'Deposit-Taking Microfinance SACCOs with Digital Channels',
    landingPageUrl: 'https://www.sasra.go.ke/regulated-saccos/',
    resolvedDocumentUrl: 'https://www.sasra.go.ke/wp-content/uploads/2026/01/List-of-Licensed-and-Authorized-SACCO-Societies-for-the-Year-Ending-31st-December-2026.pdf',
    resolvedSourceUrl: 'https://www.sasra.go.ke/wp-content/uploads/2026/01/List-of-Licensed-and-Authorized-SACCO-Societies-for-the-Year-Ending-31st-December-2026.pdf',
    documentTitle: 'List of Licensed and Authorized SACCO Societies in Kenya for the Financial Year Ending 31st December 2026',
    trustTier: 'OFFICIAL_REGULATOR',
    maxRecords: 35,
    enabled: true,
    concurrencyLimit: 2,
    retryPolicy: {
      maxRetries: 2,
      backoffMs: 2000,
    },
    lastReviewedDate: '2026-09-14',
    notes: 'Official 2026 dataset of licensed and authorized DT-SACCOs under Section 24 of the SACCO Societies Act.',
  },
  {
    sourceId: 'KE-SRC-CMA-SANDBOX',
    name: 'CMA Regulatory Sandbox Participants & Fintech Intermediaries',
    authority: 'Capital Markets Authority',
    jurisdiction: 'KE',
    sourceType: 'REGULATORY_REGISTER',
    contentAdapter: 'PDF_TABULAR',
    targetSegment: 'Wealthtech, Tokenization, Robo-Advisors, Crowdfunding',
    landingPageUrl: 'https://www.cma.or.ke/regulatory-sandbox/',
    resolvedDocumentUrl: 'https://www.cma.or.ke/regulatory-sandbox/',
    resolvedSourceUrl: 'https://www.cma.or.ke/regulatory-sandbox/',
    documentTitle: 'CMA Regulatory Sandbox Cohort Participants & Exited Fintechs',
    trustTier: 'OFFICIAL_REGULATOR',
    maxRecords: 20,
    enabled: true,
    concurrencyLimit: 1,
    retryPolicy: {
      maxRetries: 2,
      backoffMs: 3000,
    },
    lastReviewedDate: '2026-09-14',
    notes: 'Target live and exited sandbox participants requiring commercial compliance policies.',
  },
];

const SOURCE_STATE_KEY_PREFIX = 'marketing:lead-sources:state:';

// In-memory cache used as degraded fallback if Redis is unreachable
const inMemorySourceStateCache = new Map<string, DiscoverySourceState>();

/**
 * Fetch source definitions merged with persistent execution state
 */
export async function getDiscoverySources(jurisdiction: string = 'KE'): Promise<DiscoverySourceDefinition[]> {
  const sources = KENYA_DISCOVERY_SOURCES.filter(
    (s) => s.enabled && (!jurisdiction || s.jurisdiction === jurisdiction),
  );

  const results: DiscoverySourceDefinition[] = [];

  for (const src of sources) {
    const stateKey = `${SOURCE_STATE_KEY_PREFIX}${src.sourceId}`;
    let state: DiscoverySourceState | undefined;
    let isDegraded = false;

    try {
      const raw = await redis.get<string>(stateKey);
      if (raw) {
        state = typeof raw === 'string' ? JSON.parse(raw) : (raw as unknown as DiscoverySourceState);
        if (state) state.persistenceStatus = 'REDIS_PERSISTED';
      }
    } catch (err) {
      logger.warn({
        type: 'discovery_source_state_read_degraded',
        sourceId: src.sourceId,
        error: (err as Error).message,
      });
      state = inMemorySourceStateCache.get(src.sourceId);
      isDegraded = true;
      if (state) state.persistenceStatus = 'DEGRADED_UNPERSISTED';
    }

    results.push({
      ...src,
      state: state || {
        sourceId: src.sourceId,
        consecutiveFailures: 0,
        updatedAt: new Date().toISOString(),
        persistenceStatus: isDegraded ? 'DEGRADED_UNPERSISTED' : 'REDIS_PERSISTED',
      },
    });
  }

  return results;
}

/**
 * Updates the persistent source execution state upon completion or failure
 */
export async function updateDiscoverySourceState(input: UpdateDiscoverySourceStateInput): Promise<DiscoverySourceState> {
  const stateKey = `${SOURCE_STATE_KEY_PREFIX}${input.sourceId}`;
  let currentState: DiscoverySourceState | undefined;
  let isDegraded = false;

  try {
    const raw = await redis.get<string>(stateKey);
    if (raw) {
      currentState = typeof raw === 'string' ? JSON.parse(raw) : (raw as unknown as DiscoverySourceState);
    }
  } catch {
    currentState = inMemorySourceStateCache.get(input.sourceId);
    isDegraded = true;
  }

  const isSuccess = input.result === 'SUCCESS' || input.result === 'SKIPPED_UNCHANGED';
  const nowIso = new Date().toISOString();

  const newState: DiscoverySourceState = {
    sourceId: input.sourceId,
    lastSuccessfulFingerprint: isSuccess
      ? input.contentFingerprint || currentState?.lastSuccessfulFingerprint || null
      : currentState?.lastSuccessfulFingerprint || null,
    lastSuccessfulAt: isSuccess ? nowIso : currentState?.lastSuccessfulAt || null,
    lastProcessedCursor: input.processedCursor || currentState?.lastProcessedCursor || null,
    lastRecordIdentifier: input.recordIdentifier || currentState?.lastRecordIdentifier || null,
    lastSourceVersion: input.sourceVersion || currentState?.lastSourceVersion || null,
    lastResult: input.result,
    consecutiveFailures: isSuccess ? 0 : (currentState?.consecutiveFailures || 0) + 1,
    updatedAt: nowIso,
    persistenceStatus: isDegraded ? 'DEGRADED_UNPERSISTED' : 'REDIS_PERSISTED',
    metadata: {
      ...(currentState?.metadata || {}),
      ...(input.metadata || {}),
      ...(input.errorMessage ? { lastError: input.errorMessage } : {}),
      ...(isDegraded ? { degradedNotice: 'Redis unavailable; state held in process memory only' } : {}),
    },
  };

  inMemorySourceStateCache.set(input.sourceId, newState);

  try {
    // Persist for 1 year
    await redis.set(stateKey, JSON.stringify(newState), { ex: 365 * 24 * 60 * 60 });
    newState.persistenceStatus = 'REDIS_PERSISTED';
  } catch (err) {
    newState.persistenceStatus = 'DEGRADED_UNPERSISTED';
    logger.error({
      type: 'discovery_source_state_write_degraded',
      sourceId: input.sourceId,
      error: (err as Error).message,
    });
  }

  logger.info({
    type: 'discovery_source_state_updated',
    sourceId: input.sourceId,
    result: input.result,
    fingerprint: newState.lastSuccessfulFingerprint,
    cursor: newState.lastProcessedCursor,
    persistenceStatus: newState.persistenceStatus,
    consecutiveFailures: newState.consecutiveFailures,
  });

  return newState;
}
