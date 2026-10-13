import { getFrameworkMetadata } from '@/config/framework-metadata.config';
import type { GapAnalysisDepthProfile } from '@/config/gap-analysis-depth-profiles';
import { resolvePineconeNamespace } from '@/lib/rag/client';
import type { RegulatoryIntelligenceRequest } from '@/modules/regulatory-intelligence/regulatory-intelligence.service';
import type { JurisdictionContext } from '@/types/jurisdiction';

function pineconeDocumentFilter(values: readonly string[]): string | { $in: string[] } | undefined {
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : { $in: [...values] };
}

export interface GapAnalysisRetrievalContractInput {
  question: string;
  frameworkDisplay: string;
  frameworkSlug?: string;
  jurisdictionContext: JurisdictionContext;
  depthProfile: GapAnalysisDepthProfile;
  benchmarkDocumentIds?: readonly string[];
  namespace?: string;
  organizationId?: string;
}

/**
 * Canonical request contract shared by direct diagnostics and the async worker.
 * Evidence quality rules remain owned by the depth profile and RAG service.
 */
export function buildGapAnalysisRetrievalRequest(
  input: GapAnalysisRetrievalContractInput,
): RegulatoryIntelligenceRequest {
  const frameworkMetadata = input.frameworkSlug
    ? getFrameworkMetadata(input.frameworkSlug)
    : undefined;
  const documentId = pineconeDocumentFilter(input.benchmarkDocumentIds ?? []);
  const filter = {
    ...(input.frameworkSlug ? { frameworkSlug: input.frameworkSlug } : {}),
    ...(documentId ? { documentId } : {}),
  };

  return {
    question: input.question,
    feature: 'GAP_ANALYSIS',
    jurisdictionContext: input.jurisdictionContext,
    organizationContext: input.organizationId
      ? { organizationId: input.organizationId }
      : undefined,
    retrievalProfile: {
      topK: input.depthProfile.retrieval.topK,
      minScore: input.depthProfile.retrieval.minScore,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      frameworkScope: frameworkMetadata?.scope ?? 'DOMESTIC',
      namespace: resolvePineconeNamespace(input.namespace),
    },
  };
}
