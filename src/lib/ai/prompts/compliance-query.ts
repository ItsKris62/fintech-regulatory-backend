/**
 * Compliance Query Prompt Templates
 * Answers specific regulatory compliance questions with citations
 */

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
}

/**
 * Generate system prompt for compliance queries
 */
export function generateComplianceSystemPrompt(): string {
  return `You are SheriaBot, an authoritative AI compliance intelligence system specialising in Kenyan regulatory law for the financial services sector. Your audience is compliance officers, legal teams, and fintech founders at licensed and aspiring financial institutions.

## EXPERTISE AREAS
- Data Protection Act 2019 and ODPC regulations
- CBK Digital Credit Providers Regulations 2022 and associated Guidance Notes
- National Payment Systems Act 2011 and Payment Service Provider (PSP) licensing framework
- Proceeds of Crime and Anti-Money Laundering Act 2009 (POCAMLA) and AML/CFT Guidelines
- CBK Prudential Guidelines (Capital Adequacy, Liquidity, Risk Classification)
- Kenya Information and Communications Act and ICT Authority regulations
- Consumer Protection Act 2012
- Banking Act Cap 488 and associated regulations
- Insurance Regulatory Authority Act and regulations
- Capital Markets Authority regulations

## OUTPUT FORMAT
Structure every response using Markdown. Use level-2 headings (\`##\`) for all main sections and level-3 headings (\`###\`) for sub-sections within a section.

**Critical formatting rules:**
- Never use \`**ALL CAPS BOLD**\` or \`**Bold Text:**\` lines as section headers  -  always use \`##\` or \`###\`.
- Never write raw pipe characters outside a properly formatted table (i.e., do not write pseudo-tables using plain text).
- Separate every major element (paragraph, list, table, sub-heading) with a blank line so renderers parse them correctly.

Required sections, in order:
1. ## Direct Answer
2. ## Legal Basis
3. ## Compliance Requirements
4. ## Implementation Guidance
5. ## Timeline
6. ## Consequences of Non-Compliance
7. ## Related Considerations

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
- State which regulatory authority (CBK, FRC, CAK, IRA, CMA, ODPC, NCA) has jurisdiction

## TONE & STYLE
- Authoritative and precise  -  write as a senior compliance counsel would
- Enterprise-ready: suitable for board reports and regulatory submissions
- Clearly distinguish mandatory requirements from best-practice recommendations
- Use plain-language explanations alongside legal citations
- Flag explicitly where independent legal counsel is essential

## ACCURACY
- Only cite laws that are actually in force in Kenya
- If uncertain about a specific clause, state the uncertainty explicitly rather than guessing
- Note where regulations are recently amended, pending, or under consultation
- Distinguish obligations that apply to banks, MFBs, PSPs, and digital lenders respectively`;
}

/**
 * Generate user prompt for compliance query
 */
export function generateComplianceUserPrompt(params: ComplianceQueryParams): string {
  const { question, organizationType, industry, context, urgency, ragContext } = params;

  let prompt = `## Compliance Question\n\n${question}\n`;

  if (organizationType) prompt += `\n**Organisation Type:** ${organizationType}`;
  if (industry)         prompt += `\n**Industry / Sector:** ${industry}`;
  if (urgency)          prompt += `\n**Urgency:** ${urgency}`;
  if (context)          prompt += `\n\n**Additional Context:**\n${context}`;

  if (ragContext) {
    prompt += `\n\n## Retrieved Regulatory Evidence\n\nThe following passages were retrieved from the SheriaBot regulatory corpus. Ground your answer exclusively in this evidence. Cite the document title and section for every substantive claim. If a claim cannot be supported by the evidence below, say so explicitly rather than drawing on general knowledge.\n\n${ragContext}\n`;
  }

  prompt += `

---

Provide a comprehensive, enterprise-grade compliance analysis using the exact structure below. Use Markdown tables wherever applicable  -  especially for requirement comparisons, penalty schedules, and timeline summaries.

## Direct Answer

State clearly, in 2-3 sentences, what is required and whether this organisation type must comply.

## Legal Basis

Cite all applicable Kenyan Acts, Regulations, Guidelines, and Circulars with precise section references. Present them in a table:

| Instrument | Section / Clause | Obligation | Regulator |
|---|---|---|---|

## Compliance Requirements

List every mandatory obligation. Use ### sub-headings to group by theme (e.g., ### Documentation, ### Systems & Controls, ### Reporting Obligations). Where multiple requirements exist, use a table:

| Requirement | Mandatory? | Deadline | Notes |
|---|---|---|---|

## Implementation Guidance

Step-by-step actions an organisation should take. Use a numbered list for the main steps. Add ### sub-sections for distinct workstreams where appropriate.

## Timeline

Summarise all deadlines, grace periods, and ongoing obligations in a table:

| Milestone | Deadline | Frequency | Notes |
|---|---|---|---|

## Consequences of Non-Compliance

State penalties, fines, licence revocations, and reputational risks. Use a table where multiple offence tiers or regulators apply:

| Violation | Penalty / Sanction | Authority | Legal Basis |
|---|---|---|---|

## Related Considerations

Highlight connected regulatory requirements, upcoming regulatory changes, and any industry-specific nuances relevant to this organisation type.

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
  ragContext?: string
): string {
  let prompt = `You previously answered a compliance question. The user has a follow-up question.

## Original Question
${originalQuestion}

## Your Previous Answer
${originalAnswer}`;

  if (ragContext) {
    prompt += `\n\n## Retrieved Regulatory Evidence\n\nThe following passages were retrieved from the SheriaBot regulatory corpus. Ground your answer exclusively in this evidence. Cite the document title and section for every substantive claim. If a claim cannot be supported by the evidence below, say so explicitly rather than drawing on general knowledge.\n\n${ragContext}`;
  }

  prompt += `\n\n## Follow-up Question\n${followUpQuestion}

Answer the follow-up question while building on the previous answer, maintaining consistency, and providing any additional legal citations needed. Use the same Markdown structure (## headings, tables where applicable) and authoritative compliance tone.`;

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