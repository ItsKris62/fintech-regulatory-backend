/**
 * Compliance Query Prompt Templates
 * Answers specific regulatory compliance questions with citations
 */

/**
 * Compliance query request parameters
/**
 * Compliance Query Prompt Templates
 * Answers specific regulatory compliance questions with citations
 */
import { jurisdictionLabel, type JurisdictionContext } from '@/types/jurisdiction';

/**
 * Compliance query request parameters
 */
export interface ComplianceQueryParams {
  question: string;
  organizationType?: string;
  industry?: string;
  context?: string;
  urgency?: 'LOW' | 'MEDIUM' | 'HIGH';
  ragContext?: string; // formatted retrieved evidence injected by the router; bypasses answer cache
  answerDetail?: 'standard' | 'detailed';
  jurisdictionContext?: JurisdictionContext;
}

/**
 * Generate system prompt for compliance queries
 */
export function generateComplianceSystemPrompt(
  answerDetail: 'standard' | 'detailed' = 'standard',
  jurisdictionContext?: JurisdictionContext,
): string {
  const jurisdictionName = jurisdictionContext ? (jurisdictionContext.mode === 'SINGLE' ? jurisdictionLabel(jurisdictionContext.primaryJurisdiction) : jurisdictionContext.jurisdictions.map(jurisdictionLabel).join(', ')) : 'Kenya';
  const jurisdictionCode = jurisdictionContext ? (jurisdictionContext.mode === 'SINGLE' ? jurisdictionContext.primaryJurisdiction : jurisdictionContext.jurisdictions.join(', ')) : 'KE';
  return `You are SheriaBot, an authoritative AI compliance intelligence system specialising in ${jurisdictionName} regulatory law for the financial services sector. Your audience is compliance officers, legal teams, and fintech founders at licensed and aspiring financial institutions.

Active jurisdiction: ${jurisdictionName} (${jurisdictionCode}).
Do not infer or substitute a different jurisdiction. If the provided evidence does not support a legal claim for ${jurisdictionName}, say the available corpus is insufficient.

## EXPERTISE AREAS
- Financial-services licensing and regulatory perimeter obligations in ${jurisdictionName}
- Payment service provider, e-money, banking, lending, insurance, and capital-markets obligations where supported by retrieved evidence
- Data protection, cybersecurity, AML/CFT, consumer protection, governance, reporting, and prudential obligations where supported by retrieved evidence
- Regulator-specific circulars, directives, regulations, guidance, and legislation for ${jurisdictionName}

## OUTPUT FORMAT
Structure every response using Markdown. Use level-2 headings (\`##\`) for all main sections and level-3 headings (\`###\`) for sub-sections within a section.

**Critical formatting rules:**
- Never use \`**ALL CAPS BOLD**\` or \`**Bold Text:**\` lines as section headers  -  always use \`##\` or \`###\`.
- Never write raw pipe characters outside a properly formatted table (i.e., do not write pseudo-tables using plain text).
- Separate every major element (paragraph, list, table, sub-heading) with a blank line so renderers parse them correctly.

Required sections, in order:
${answerDetail === 'standard' ? `
1. ## Direct Answer
2. ## Key Obligations
3. ## Practical Next Steps
4. ## Referenced Documents and Sections` : `
1. ## Executive Summary
2. ## Applicable Legal Context
3. ## Compliance Obligations
4. ## Implementation Steps
5. ## Recommended Controls
6. ## Risks and Consequences
7. ## Limitations
8. ## Referenced Documents and Sections`}

## TABLES
Use Markdown GFM tables whenever you are:
- Comparing multiple regulatory instruments or requirements
- Listing obligations with corresponding deadlines, penalties, or regulatory authorities
- Presenting a compliance checklist with status or priority columns
- Summarising fines, capital thresholds, or transaction limits

Rules for tables:
1. Every table **must** have a header row followed immediately by a separator row (\`|---|---|\`).
2. Always insert a **blank line before the first \`|\` row** and a **blank line after the last \`|\` row**. This is required for Markdown parsers to correctly identify table blocks.
3. Do **not** use bold text (\`**text**\`) as a substitute for table headers  -  use the pipe-delimited header row.
4. Keep cell content concise; prefer short phrases over full sentences inside cells.

Example (note the blank lines surrounding the table):

| Requirement | Legal Basis | Deadline | Regulator |
|---|---|---|---|
| AML Policy | POCAMLA 2009, s.45 | Before launch | FRC |
| DPA Registration | DPA 2019, s.17 | Before processing personal data | ODPC |

## CITATION REQUIREMENTS
- Cite specific Acts, Section numbers, and sub-clauses (e.g., "Data Protection Act 2019, Section 25(1)(a)")
- Reference CBK Circulars, Guidance Notes, and Prudential Guidelines by number and date where known
- Distinguish: Acts (primary legislation) | Regulations (statutory instruments) | Guidelines (regulatory guidance) | Circulars (supervisory directives)
- State which regulatory authority has jurisdiction where the retrieved evidence identifies it

## TONE & STYLE
- Authoritative and precise  -  write as a senior compliance counsel would
- Enterprise-ready: suitable for board reports and regulatory submissions
- Clearly distinguish mandatory requirements from best-practice recommendations
- Use plain-language explanations alongside legal citations
- Flag explicitly where independent legal counsel is essential

## ACCURACY
- Only cite laws that are actually in force in ${jurisdictionName}, unless a retrieved source is explicitly labelled DRAFT, CONSULTATION, or SUPERSEDED
- If uncertain about a specific clause, state the uncertainty explicitly rather than guessing
- Note where regulations are recently amended, pending, or under consultation
- Distinguish obligations that apply to banks, MFBs, PSPs, and digital lenders respectively

## SOURCE ATTRIBUTION
- Use ONLY the provided regulatory context for legal claims. Do not invent citations to documents not in the provided context.
- Refer only to document titles, sections, regulators, and legal instruments that appear in the retrieved context.
- Do not create standalone citation lists, fake citation labels, page numbers, source URLs, or provision IDs. The application attaches source-list citations from accepted retrieved chunks separately.
- Keep grounded legal claims short and evidence-close: one legal requirement per sentence or bullet, preferably under 30 words.
- Do not combine several legal requirements, limitations, recommendations, and citations into a single sentence.
- For standard answers, avoid Markdown tables unless the user explicitly asks for a table; short bullets verify more reliably.
- Use the regulated actor exactly as the evidence states. Do not broaden "bank", "financial institution", "digital credit provider", "data controller", or "data processor" into "PSP" or "fintech company" unless the accepted evidence expressly supports that actor.
- If the question asks about PSPs or fintechs but the accepted evidence is broader or narrower, state the limited evidence scope instead of generalising.
- Avoid interpretive filler such as "foundational requirement" unless that phrasing is directly supported by the evidence.
- Avoid vague meta-claims such as "the retrieved evidence confirms that these actors must comply"; state the concrete source-backed rule instead.
- If the provided context is insufficient to fully answer the question, state this clearly: "The available regulatory corpus does not contain sufficient information on [topic]."
- Distinguish between:
  - Corpus-supported answers: claims backed by the retrieved regulatory evidence.
  - Partial answers: where the context addresses some but not all aspects of the question.
  - Unsupported claims: where no retrieved evidence supports the assertion — do not make these.
- Never fabricate section numbers, clause references, or document titles.`;
}

/**
 * Generate user prompt for compliance query
 */
export function generateComplianceUserPrompt(params: ComplianceQueryParams): string {
  const { question, organizationType, industry, context, urgency, ragContext, answerDetail = 'standard', jurisdictionContext } = params;
  const jurisdictionName = jurisdictionContext ? (jurisdictionContext.mode === 'SINGLE' ? jurisdictionLabel(jurisdictionContext.primaryJurisdiction) : jurisdictionContext.jurisdictions.map(jurisdictionLabel).join(', ')) : 'Kenya';
  const jurisdictionCode = jurisdictionContext ? (jurisdictionContext.mode === 'SINGLE' ? jurisdictionContext.primaryJurisdiction : jurisdictionContext.jurisdictions.join(', ')) : 'KE';

  let prompt = `## Active Jurisdiction\n\n${jurisdictionName} (${jurisdictionCode})\n\n## Compliance Question\n\n${question}\n`;

  if (organizationType) prompt += `\n**Organisation Type:** ${organizationType}`;
  if (industry)         prompt += `\n**Industry / Sector:** ${industry}`;
  if (urgency)          prompt += `\n**Urgency:** ${urgency}`;
  if (context)          prompt += `\n\n**Additional Context:**\n${context}`;

  if (ragContext) {
    prompt += `\n\n## Retrieved Regulatory Evidence\n\nThe following passages were retrieved from the SheriaBot regulatory corpus for ${jurisdictionName} (${jurisdictionCode}) and accepted for this answer. Ground your answer exclusively in this evidence. Refer only to document titles and sections present below. Do not create standalone citation lists, fake citation labels, page numbers, source URLs, or provision IDs; the application attaches source-list citations from accepted chunks separately. If a claim cannot be supported by the evidence below, explicitly state that the corpus does not contain relevant provisions rather than relying on model memory or fabricating citations.\n\nSome retrieved sources may be labelled Authority Status: DRAFT, CONSULTATION, or SUPERSEDED with Binding Law: No. You may use those sources, but every reference to them must be clearly labelled as non-binding draft/consultation/superseded material and must not be framed as current binding law.\n\n${ragContext}\n`;
  }
  prompt += `

---

Provide a ${answerDetail === 'standard' ? 'concise but complete compliance analysis focusing on practical next actions' : 'comprehensive, enterprise-grade compliance analysis with enough detail for a board, compliance lead, or product owner to act on'}. Use the exact structure below. ${answerDetail === 'standard' ? 'Use short paragraphs and bullets; avoid tables unless the user explicitly asks for a table.' : 'Use Markdown tables wherever applicable  -  especially for requirement comparisons, penalty schedules, controls, risks, and timeline summaries.'}

${answerDetail === 'standard' ? `## Direct Answer

State clearly, in 2-3 sentences, what is required and whether this organisation type must comply.
Only state that the organisation type must comply when the accepted evidence directly supports that scope; otherwise state the narrower or broader actor named in the evidence.

## Key Obligations

List the main mandatory obligations derived from the regulatory evidence. Mention the source document or section beside each obligation where available.
Use the exact regulated actor named in the evidence for each obligation.

## Practical Next Steps

Provide 2-3 immediate, practical actions the organisation should take.

## Referenced Documents and Sections

Cite the specific regulatory documents and sections used in this answer. Use bullet points and include every retrieved source you relied on.` : `## Executive Summary

Summarise the conclusion in 3-5 sentences. State what the organisation must do, which regulators are implicated, and whether the retrieved corpus fully or partially supports the answer.

## Applicable Legal Context

Explain the legal and regulatory context using only retrieved evidence. Cite applicable ${jurisdictionName} Acts, Regulations, Guidelines, and Circulars with section references where they appear in the retrieved chunks. Present them in a table:

| Instrument | Section / Clause | Obligation | Regulator |
|---|---|---|---|

## Compliance Obligations

List mandatory obligations. Use ### sub-headings to group by theme (e.g., ### Governance, ### Customer Due Diligence, ### Data Protection, ### Reporting, ### Records, ### Systems & Controls). Where multiple requirements exist, use a table:

| Requirement | Mandatory? | Deadline | Notes |
|---|---|---|---|

## Implementation Steps

Give step-by-step actions an organisation should take. Use a numbered list for the main steps. Add ### sub-sections for distinct workstreams where appropriate.

## Recommended Controls

Recommend practical controls, policies, registers, monitoring routines, board approvals, staff training, reporting workflows, and evidence artefacts. Use a table:

| Control | Purpose | Evidence to Keep | Owner |
|---|---|---|---|

## Risks and Consequences

State legal, regulatory, operational, licence, enforcement, and reputational risks supported by the retrieved sources. Use a table where multiple risk categories or regulators apply:

| Risk | Consequence | Authority | Legal Basis |
|---|---|---|---|

## Limitations

State what the retrieved corpus does not conclusively establish. Do not make unsupported claims.

## Referenced Documents and Sections

List every retrieved source document used in the answer. Include section, clause, page, or heading metadata where available. If section metadata is missing but the document title and content were used, list the document title and say "section not specified in metadata".`}

---

Cite specific laws and regulations throughout. Use authoritative, enterprise-grade language suitable for a board compliance report.`;

  return prompt;
}

/**
 * Generate prompt for follow-up query
 */
export function generateFollowUpQueryPrompt(
  originalQuestion: string,
  originalAnswer: string,
  followUpQuestion: string,
  ragContext?: string,
  jurisdictionContext?: JurisdictionContext,
): string {
  const jurisdictionName = jurisdictionContext ? (jurisdictionContext.mode === 'SINGLE' ? jurisdictionLabel(jurisdictionContext.primaryJurisdiction) : jurisdictionContext.jurisdictions.map(jurisdictionLabel).join(', ')) : 'Kenya';
  const jurisdictionCode = jurisdictionContext ? (jurisdictionContext.mode === 'SINGLE' ? jurisdictionContext.primaryJurisdiction : jurisdictionContext.jurisdictions.join(', ')) : 'KE';
  let prompt = `You previously answered a compliance question for ${jurisdictionName} (${jurisdictionCode}). The user has a follow-up question.

Active jurisdiction: ${jurisdictionName} (${jurisdictionCode}). Do not change jurisdictions unless explicitly instructed by the system.

## Original Question
${originalQuestion}

## Your Previous Answer
${originalAnswer}`;

  if (ragContext) {
    prompt += `\n\n## Retrieved Regulatory Evidence\n\nThe following passages were retrieved from the SheriaBot regulatory corpus and accepted for this answer. Ground your answer exclusively in this evidence. Refer only to document titles and sections present below. Do not create standalone citation lists, fake citation labels, page numbers, source URLs, or provision IDs; the application attaches source-list citations from accepted chunks separately. If a claim cannot be supported by the evidence below, explicitly state that the corpus does not contain relevant provisions rather than relying on model memory or fabricating citations.\n\nSome retrieved sources may be labelled Authority Status: DRAFT, CONSULTATION, or SUPERSEDED with Binding Law: No. You may use those sources, but every reference to them must be clearly labelled as non-binding draft/consultation/superseded material and must not be framed as current binding law.\n\n${ragContext}`;
  }

  prompt += `\n\n## Follow-up Question\n${followUpQuestion}

Answer the follow-up question while building on the previous answer, maintaining consistency, and referring only to source titles/sections present in the retrieved evidence. Do not create standalone citation labels; the application attaches accepted source-list citations separately. Use the same Markdown structure (## headings, tables where applicable) and authoritative compliance tone.`;

  return prompt;
}

/**
 * Generate prompt for quick compliance check
 */
export function generateQuickCheckPrompt(scenario: string): string {
  return `Perform a quick compliance check for this scenario:

**SCENARIO:**
${scenario}

Provide:
1. **Compliance Status**: ✓ COMPLIANT / ⚠ PARTIALLY COMPLIANT / ✗ NON-COMPLIANT
2. **Key Issues**: 2-3 main compliance concerns (if any)
3. **Immediate Actions**: What to do right now
4. **Legal Basis**: Main laws/regulations involved
5. **Risk Level**: LOW / MEDIUM / HIGH

Keep response concise (under 500 words) but include specific citations.`;
}

/**
 * Generate prompt for regulatory comparison
 */
export function generateRegulatoryComparisonPrompt(
  requirement1: string,
  requirement2: string
): string {
  return `Compare these two regulatory requirements in Kenya:

**REQUIREMENT 1:**
${requirement1}

**REQUIREMENT 2:**
${requirement2}

Analyze:
1. **Similarities**: How are they similar?
2. **Differences**: Key differences
3. **Overlap**: Areas of overlap or conflict
4. **Compliance Strategy**: How to comply with both
5. **Legal Citations**: Specific laws for each

Provide a clear comparison that helps understand how to meet both requirements.`;
}

/**
 * Generate prompt for regulatory update summary
 */
export function generateRegulatoryUpdatePrompt(
  regulatoryArea: string,
  timeframe: string
): string {
  return `Summarize recent regulatory updates in Kenya for:

**REGULATORY AREA:**
${regulatoryArea}

**TIMEFRAME:**
${timeframe}

For each update, provide:
1. **What Changed**: Summary of the change
2. **Effective Date**: When it takes effect
3. **Who's Affected**: Which organizations/industries
4. **Action Required**: What organizations need to do
5. **Legal Citation**: Reference to the regulation/circular

Focus on updates that are actually happening in Kenya. If no recent updates, state that clearly.`;
}

/**
 * Generate prompt for industry-specific guidance
 */
export function generateIndustryGuidancePrompt(
  industry: string,
  topic: string
): string {
  return `Provide compliance guidance specific to the ${industry} industry in Kenya:

**TOPIC:**
${topic}

Include:
1. **Industry Overview**: Key regulatory considerations for ${industry}
2. **Specific Requirements**: Requirements unique to this industry
3. **Regulatory Bodies**: Which regulators oversee this
4. **Common Challenges**: Typical compliance issues
5. **Best Practices**: Industry-standard approaches
6. **Legal Framework**: Main laws and regulations

Tailor your answer to the ${industry} context in Kenya.`;
}

/**
 * Build a map of { lowercase-title -> content } by splitting the response
 * on ## level-2 headings. Robust to extra blank lines and whitespace.
 */
function buildSectionMap(response: string): Record<string, string> {
  const map: Record<string, string> = {};
  // Split at the start of every line that begins with "## "
  const chunks = response.split(/^(?=## )/m);
  for (const chunk of chunks) {
    const m = chunk.match(/^## ([^\n]+)\n?([\s\S]*)/);
    if (m) {
      map[m[1].trim().toLowerCase()] = m[2].trim();
    }
  }
  return map;
}

/**
 * Extract answer sections from AI response.
 *
 * Supports both the new ## heading format (primary) and the legacy
 * **BOLD HEADER** format (fallback) so old stored responses still parse.
 */
export function extractAnswerSections(response: string): {
  directAnswer: string;
  legalBasis: string;
  requirements: string;
  guidance: string;
  timeline: string;
  consequences: string;
  relatedConsiderations: string;
  citations: string[];
} {
  // -- New format: ## Headings ------------------------------------------------
  const map = buildSectionMap(response);

  const get = (...keys: string[]): string => {
    for (const key of keys) {
      const val = map[key.toLowerCase()];
      if (val) return val;
    }
    return '';
  };

  const fromMap = {
    directAnswer:          get('direct answer', 'executive summary', 'overview'),
    legalBasis:            get('legal basis', 'legal basis & citations', 'legal framework'),
    requirements:          get('compliance requirements', 'requirements'),
    guidance:              get('implementation guidance', 'implementation steps', 'guidance'),
    timeline:              get('timeline', 'timeline & deadlines', 'deadlines'),
    consequences:          get('consequences of non-compliance', 'non-compliance consequences', 'consequences'),
    relatedConsiderations: get('related considerations', 'additional considerations'),
  };

  // -- Legacy fallback: **BOLD HEADERS** -------------------------------------
  // Used only when the response contains no ## headings (e.g. older stored answers)
  const hasHeadings = Object.values(fromMap).some((v) => v.length > 0);

  const legacyGet = (pattern: RegExp): string => {
    const m = response.match(pattern);
    return m ? m[1].trim() : '';
  };

  const directAnswer = fromMap.directAnswer ||
    legacyGet(/\*\*DIRECT ANSWER\*\*([\s\S]*?)(?=\*\*[A-Z]|$)/i);
  const legalBasis = fromMap.legalBasis ||
    legacyGet(/\*\*LEGAL BASIS\*\*([\s\S]*?)(?=\*\*[A-Z]|$)/i);
  const requirements = fromMap.requirements ||
    legacyGet(/\*\*COMPLIANCE REQUIREMENTS\*\*([\s\S]*?)(?=\*\*[A-Z]|$)/i);
  const guidance = fromMap.guidance ||
    legacyGet(/\*\*IMPLEMENTATION GUIDANCE\*\*([\s\S]*?)(?=\*\*[A-Z]|$)/i);
  const timeline = fromMap.timeline ||
    legacyGet(/\*\*TIMELINE\*\*([\s\S]*?)(?=\*\*[A-Z]|$)/i);
  const consequences = fromMap.consequences ||
    legacyGet(/\*\*NON-COMPLIANCE CONSEQUENCES\*\*([\s\S]*?)(?=\*\*[A-Z]|$)/i);
  const relatedConsiderations = fromMap.relatedConsiderations ||
    legacyGet(/\*\*RELATED CONSIDERATIONS\*\*([\s\S]*?)(?=\*\*[A-Z]|$)/i);

  // -- Citations --------------------------------------------------------------
  const citationRegex = /([A-Z][A-Za-z\s]+Act\s+\d{4}(?:,\s+[Ss]ection\s+\d+(?:\([a-z0-9]+\))*)?|[A-Z][A-Za-z\s]+Regulations?\s+\d{4})/g;
  const matches = response.match(citationRegex);
  const citations = matches ? [...new Set(matches)] : [];

  void hasHeadings; // suppress unused-var warning  -  intentionally kept for docs

  return {
    directAnswer,
    legalBasis,
    requirements,
    guidance,
    timeline,
    consequences,
    relatedConsiderations,
    citations,
  };
}

/**
 * Generate prompt for citation validation
 */
export function generateCitationValidationPrompt(
  answer: string,
  citations: string[]
): string {
  return `Review this compliance answer and verify that all legal citations are accurate:

**ANSWER:**
${answer}

**CITATIONS FOUND:**
${citations.map((c, i) => `${i + 1}. ${c}`).join('\n')}

For each citation:
1. Verify it exists in Kenyan law
2. Check section/clause numbers are correct
3. Confirm it's relevant to the answer
4. Note if more recent versions exist

Respond with:
✓ VERIFIED: Citation is accurate
⚠ CHECK: May need verification
✗ ERROR: Incorrect citation

Include explanations for warnings and errors.`;
}
