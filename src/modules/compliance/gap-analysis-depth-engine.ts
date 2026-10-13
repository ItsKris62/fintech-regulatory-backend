import type { GapAnalysisDepthProfile } from '@/config/gap-analysis-depth-profiles';
import type { PolicyChunk, RawChunkGapItem } from '@/lib/ai/prompts/gap-analysis';

export interface DepthExecutionTelemetry {
  retrievalQueryCount: number;
  retrievalCandidateCount: number;
  acceptedEvidenceCount: number;
  weakEvidenceRetryCount: number;
  documentChunks: number;
  processedChunks: number;
  analysisCallCount: number;
  verificationCallCount: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  limitations: string[];
}

export class GapAnalysisBudgetExceededError extends Error {
  readonly retryable = false;

  constructor(readonly budget: string) {
    super(`Gap Analysis execution stopped at its configured ${budget} limit.`);
    this.name = 'GapAnalysisBudgetExceededError';
  }
}

export class GapAnalysisExecutionBudget {
  private modelCalls = 0;
  private estimatedInputTokens = 0;
  private reservedOutputTokens = 0;
  private retrievalOperations = 0;

  constructor(
    private readonly profile: GapAnalysisDepthProfile,
    private readonly startedAt: number,
    private readonly assertActive: () => Promise<void>,
  ) {}

  async beforeRetrieval(estimatedInputTokens: number, maxOutputTokens = 2048): Promise<void> {
    if (this.retrievalOperations >= this.profile.retrieval.maxRetrievalOperations) {
      throw new GapAnalysisBudgetExceededError('retrieval-operation');
    }
    this.retrievalOperations++;
    await this.beforeModelCall(estimatedInputTokens, maxOutputTokens);
  }

  async beforeModelCall(estimatedInputTokens: number, maxOutputTokens: number): Promise<void> {
    await this.assertActive();
    if (Date.now() - this.startedAt >= this.profile.budget.maxWallClockMs) {
      throw new GapAnalysisBudgetExceededError('wall-clock');
    }
    if (this.modelCalls + 1 > this.profile.budget.maxModelCalls) {
      throw new GapAnalysisBudgetExceededError('model-call');
    }
    if (this.estimatedInputTokens + estimatedInputTokens > this.profile.budget.maxInputTokens) {
      throw new GapAnalysisBudgetExceededError('input-token');
    }
    if (this.reservedOutputTokens + maxOutputTokens > this.profile.budget.maxOutputTokens) {
      throw new GapAnalysisBudgetExceededError('output-token');
    }
    this.modelCalls++;
    this.estimatedInputTokens += Math.max(0, estimatedInputTokens);
    this.reservedOutputTokens += Math.max(0, maxOutputTokens);
  }

  snapshot(): { modelCalls: number; estimatedInputTokens: number; reservedOutputTokens: number; retrievalOperations: number } {
    return {
      modelCalls: this.modelCalls,
      estimatedInputTokens: this.estimatedInputTokens,
      reservedOutputTokens: this.reservedOutputTokens,
      retrievalOperations: this.retrievalOperations,
    };
  }
}

export function estimatePromptTokens(...parts: Array<string | undefined>): number {
  return Math.ceil(parts.reduce((sum, part) => sum + (part?.length ?? 0), 0) / 4);
}

export function buildDepthRetrievalQueries(params: {
  framework: string;
  jurisdictionNames: string;
  policyKeywords: string[];
  profile: GapAnalysisDepthProfile;
}): string[] {
  const keywordText = params.policyKeywords.length > 0 ? ` Policy topics: ${params.policyKeywords.join(', ')}.` : '';
  const base = `${params.framework} ${params.jurisdictionNames}`;
  const queries = params.profile.depth === 'quick'
    ? [`${base} material high-risk regulatory obligations enforcement requirements.${keywordText}`]
    : params.profile.depth === 'standard'
    ? [
        `${base} substantive regulatory obligations and required controls.${keywordText}`,
        `${base} governance reporting recordkeeping notification and implementation requirements.${keywordText}`,
      ]
    : [
        `${base} substantive regulatory obligations and required controls.${keywordText}`,
        `${base} governance reporting recordkeeping notification and implementation requirements.${keywordText}`,
        `${base} requirement evidence definitions oversight escalation remediation and audit obligations.${keywordText}`,
      ];
  return queries.slice(0, params.profile.retrieval.queriesPerFramework);
}

export function buildWeakEvidenceRetryQuery(params: {
  framework: string;
  jurisdictionNames: string;
  policyKeywords: string[];
}): string {
  const topics = params.policyKeywords.length > 0 ? params.policyKeywords.join(', ') : 'policy controls';
  return `${params.framework} ${params.jurisdictionNames} exact operative provisions requirements exceptions deadlines and enforcement for ${topics}`;
}

export function selectPolicyChunksForDepth(
  chunks: PolicyChunk[],
  profile: GapAnalysisDepthProfile,
): { selected: PolicyChunk[]; skipped: number; completeConfiguredTraversal: boolean } {
  if (chunks.length <= profile.document.maxChunks) {
    return { selected: chunks, skipped: 0, completeConfiguredTraversal: true };
  }

  if (profile.depth !== 'quick') {
    return {
      selected: chunks.slice(0, profile.document.maxChunks),
      skipped: chunks.length - profile.document.maxChunks,
      completeConfiguredTraversal: false,
    };
  }

  const last = chunks.length - 1;
  const indexes = [...new Set([0, Math.floor(last / 3), Math.floor((2 * last) / 3), last])]
    .slice(0, profile.document.maxChunks)
    .sort((a, b) => a - b);
  const selected = indexes.map((index) => chunks[index]);
  return {
    selected,
    skipped: chunks.length - selected.length,
    completeConfiguredTraversal: false,
  };
}

export function mergeEnhancedRawFindings(
  baseline: RawChunkGapItem[],
  enhanced: RawChunkGapItem[],
): RawChunkGapItem[] {
  const merged = [...baseline];
  const identities = new Set(
    baseline.map((finding) => `${finding.framework}|${finding.id}|${finding.title}`.toLowerCase()),
  );
  for (const finding of enhanced) {
    const identity = `${finding.framework}|${finding.id}|${finding.title}`.toLowerCase();
    if (!identities.has(identity)) {
      identities.add(identity);
      merged.push(finding);
    }
  }
  return merged;
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, values.length)) }, async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
