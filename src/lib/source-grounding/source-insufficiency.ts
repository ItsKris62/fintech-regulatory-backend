import type { SearchResult } from '@/lib/rag/rag.service';
import type { AnswerClaimVerification } from './claim-verification';

export type ComplianceFallbackReason =
  | 'NO_RAG_CHUNKS'
  | 'ALL_CHUNKS_FAILED_VERIFICATION'
  | 'EXTERNAL_PROVIDER_BILLING_BLOCKER'
  | 'LOW_RELEVANCE'
  | 'OUT_OF_SCOPE'
  | 'ROUTE_ERROR';

export const COMPLIANCE_SOURCE_INSUFFICIENCY_MESSAGE =
  'SheriaBot could not find a sufficiently verified source in the indexed corpus for this specific question.';

export const COMPLIANCE_FALLBACK_MESSAGES: Record<ComplianceFallbackReason, string> = {
  NO_RAG_CHUNKS: 'No sufficiently relevant indexed documents were retrieved for this question.',
  ALL_CHUNKS_FAILED_VERIFICATION: 'SheriaBot found potentially related documents, but they were not strong enough to support a verified answer.',
  EXTERNAL_PROVIDER_BILLING_BLOCKER: 'SheriaBot could not complete source verification because an upstream AI verification service is temporarily unavailable.',
  LOW_RELEVANCE: COMPLIANCE_SOURCE_INSUFFICIENCY_MESSAGE,
  OUT_OF_SCOPE: 'This question is outside SheriaBot\'s Kenyan fintech compliance scope.',
  ROUTE_ERROR: COMPLIANCE_SOURCE_INSUFFICIENCY_MESSAGE,
};

export const GAP_ANALYSIS_SOURCE_INSUFFICIENCY_MESSAGE =
  'The selected benchmark/source documents do not provide enough verified regulatory evidence to complete this legal gap assessment. Please select stronger benchmark documents or add the missing regulatory source.';

export const POLICY_SOURCE_INSUFFICIENCY_MESSAGE =
  'I cannot generate legal citations or legal obligations for this policy without verified source documents. Please attach or select the relevant regulatory sources first.';

export function hasUsableSourceContext(input: {
  results?: SearchResult[] | null;
  context?: string | null;
}): boolean {
  return (input.results?.length ?? 0) > 0 && !!input.context?.trim();
}

export function buildComplianceSourceInsufficiencyAnswer(
  fallbackReason: ComplianceFallbackReason | null = null,
): string {
  const message = fallbackReason ? COMPLIANCE_FALLBACK_MESSAGES[fallbackReason] : COMPLIANCE_SOURCE_INSUFFICIENCY_MESSAGE;
  const noSourceClaim = fallbackReason === 'NO_RAG_CHUNKS'
    ? 'no sufficiently relevant source chunk was retrieved.'
    : fallbackReason === 'EXTERNAL_PROVIDER_BILLING_BLOCKER'
      ? 'source verification could not be completed.'
    : 'no supporting source chunk was verified.';

  return `## Source status

${message}

## Non-legal operational next steps

- Narrow the question to a specific regulator, framework, Act, Regulation, Guideline, or Circular.
- Add or select the relevant regulatory source document if it is missing from the corpus.
- Re-run the question after the relevant source material is available.

I have not stated legal obligations, penalties, deadlines, thresholds, or compliance conclusions because ${noSourceClaim}`;
}

export function buildUnsupportedClaimsAnswer(unsupportedClaims: string[]): string {
  const claims = unsupportedClaims
    .slice(0, 5)
    .map((claim) => `- ${claim}`)
    .join('\n');

  return `## Source verification failed

I found retrieved source material, but one or more legal/compliance claims in the generated draft could not be verified against the accepted source chunks. I have not returned the draft answer because SheriaBot requires every legal claim to be supported by accepted corpus evidence.

${claims ? `## Unsupported claim candidates\n\n${claims}\n\n` : ''}## Next steps

- Narrow the question to the exact regulator, framework, Act, Regulation, Guideline, or Circular.
- Add or select stronger source documents if the corpus is missing the relevant provision.
- Re-run the question after the relevant source material is available.`;
}

export function buildPartiallySupportedClaimsAnswer(
  supportedClaims: AnswerClaimVerification[],
  unsupportedClaims: AnswerClaimVerification[],
): string {
  const verifiedClaims = supportedClaims
    .slice(0, 10)
    .map((claim) => `- ${claim.claimText}`)
    .join('\n');

  const excludedCount = unsupportedClaims.length;
  const excludedNote = excludedCount > 0
    ? `\n\n${excludedCount} unsupported claim candidate${excludedCount === 1 ? '' : 's'} were excluded from this answer.`
    : '';

  return `## Verified answer

${verifiedClaims}

## Verification note

Only claims supported by accepted corpus evidence are shown.${excludedNote}`;
}

export class SourceInsufficiencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceInsufficiencyError';
  }
}
