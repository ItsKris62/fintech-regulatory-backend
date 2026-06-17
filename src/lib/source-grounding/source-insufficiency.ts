import type { SearchResult } from '@/lib/rag/rag.service';

export const COMPLIANCE_SOURCE_INSUFFICIENCY_MESSAGE =
  'I could not verify this from the currently available SheriaBot source corpus. Please add or select the relevant regulatory document, or try narrowing the question to a specific framework, regulator, or document.';

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

export function buildComplianceSourceInsufficiencyAnswer(): string {
  return `## Source status

${COMPLIANCE_SOURCE_INSUFFICIENCY_MESSAGE}

## Non-legal operational next steps

- Narrow the question to a specific regulator, framework, Act, Regulation, Guideline, or Circular.
- Add or select the relevant regulatory source document if it is missing from the corpus.
- Re-run the question after the relevant source material is available.

I have not stated legal obligations, penalties, deadlines, thresholds, or compliance conclusions because no supporting source chunk was retrieved.`;
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

export class SourceInsufficiencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceInsufficiencyError';
  }
}
