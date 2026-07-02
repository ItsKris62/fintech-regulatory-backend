import { queryVectors as defaultQueryVectors } from '@/lib/rag/client';
import { logger } from '@/utils/logger';
import type { ClassifiedSignalCore, CorpusGapResult } from './types';

interface QueryResultLike {
  id: string;
  score: number;
  metadata: {
    documentTitle?: string;
    framework?: string;
    frameworkSlug?: string;
    source?: string;
    jurisdiction?: string;
  };
}

type QueryVectors = (
  queryText: string,
  topK?: number,
  namespace?: string,
  filter?: Record<string, unknown>,
) => Promise<QueryResultLike[]>;

export interface CorpusGapDependencies {
  queryVectors?: QueryVectors;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function resultMatchesFramework(result: QueryResultLike, framework: string): boolean {
  const needle = normalize(framework);
  const haystack = normalize([
    result.metadata.documentTitle,
    result.metadata.framework,
    result.metadata.frameworkSlug,
    result.metadata.source,
  ].filter((value): value is string => typeof value === 'string').join(' '));
  if (!haystack || !needle) return false;
  return haystack.includes(needle) || needle.includes(haystack);
}

export class CorpusGapService {
  private readonly queryVectors: QueryVectors;

  constructor(dependencies: CorpusGapDependencies = {}) {
    this.queryVectors = dependencies.queryVectors ?? defaultQueryVectors;
  }

  async checkSignal(agentRunId: string, signal: ClassifiedSignalCore): Promise<CorpusGapResult> {
    const frameworks = signal.referencedFrameworks.length > 0
      ? signal.referencedFrameworks
      : [signal.title];
    const missingFrameworks: string[] = [];
    const matchedFrameworks: string[] = [];
    const checkedQueries: string[] = [];

    for (const framework of frameworks) {
      const query = `${framework} ${signal.jurisdiction} ${signal.regulatoryBody}`.trim();
      checkedQueries.push(query);
      const results = await this.queryVectors(query, 5, undefined, { jurisdiction: signal.jurisdiction });
      if (results.some((result) => result.score >= 0.72 || resultMatchesFramework(result, framework))) {
        matchedFrameworks.push(framework);
      } else {
        missingFrameworks.push(framework);
      }
    }

    const corpusGapDetected = missingFrameworks.length > 0;
    if (corpusGapDetected) {
      logger.warn({ type: 'reg_intel_corpus_gap_detected', agentRunId, sourceUrl: signal.sourceUrl, missingFrameworks });
    } else {
      logger.info({ type: 'reg_intel_corpus_gap_checked', agentRunId, sourceUrl: signal.sourceUrl, matchedFrameworks });
    }

    return {
      corpusGapDetected,
      corpusGapDetails: {
        missingFrameworks,
        checkedQueries,
        matchedFrameworks,
      },
    };
  }
}

export const corpusGapService = new CorpusGapService();