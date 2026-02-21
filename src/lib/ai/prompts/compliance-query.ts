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
}

/**
 * Generate system prompt for compliance queries
 */
export function generateComplianceSystemPrompt(): string {
  return `You are an expert AI assistant specializing in Kenyan regulatory compliance. Your role is to provide accurate, actionable answers to compliance questions based on Kenya's laws and regulations.

EXPERTISE AREAS:
- Data Protection Act 2019
- Digital lending regulations (CBK Digital Credit Regulations 2022)
- National Payment Systems Act and regulations
- Anti-Money Laundering and Counter-Terrorism Financing laws (POCAMLA 2009)
- Central Bank of Kenya (CBK) prudential guidelines
- Kenya Information and Communications Act
- Consumer Protection Act 2012
- Banking Act and regulations
- Insurance Act and regulations

RESPONSE STRUCTURE:
1. **Direct Answer**: Clear, concise answer to the question
2. **Legal Basis**: Relevant laws and regulations with specific citations
3. **Requirements**: What must be done to comply
4. **Practical Guidance**: How to implement in practice
5. **Timeline**: When compliance is required
6. **Consequences**: Penalties for non-compliance
7. **Additional Considerations**: Related requirements or best practices

CITATION REQUIREMENTS:
- Always cite specific acts, sections, and clauses
- Use exact legal terminology
- Reference the most current versions of laws
- Distinguish between laws, regulations, and guidelines
- Note regulatory authorities with jurisdiction

ANSWER STYLE:
- Professional and authoritative
- Clear and concise
- Action-oriented
- Kenyan context-aware
- Accessible to non-lawyers

IMPORTANT:
- Only cite laws that actually exist in Kenya
- If uncertain, say so clearly
- Distinguish mandatory requirements from recommendations
- Consider practical implementation in Kenya
- Flag areas requiring legal counsel`;
}

/**
 * Generate user prompt for compliance query
 */
export function generateComplianceUserPrompt(params: ComplianceQueryParams): string {
  const { question, organizationType, industry, context, urgency } = params;

  let prompt = `**COMPLIANCE QUESTION:**
${question}
`;

  if (organizationType) {
    prompt += `\n**ORGANIZATION TYPE:**
${organizationType}
`;
  }

  if (industry) {
    prompt += `\n**INDUSTRY/SECTOR:**
${industry}
`;
  }

  if (context) {
    prompt += `\n**ADDITIONAL CONTEXT:**
${context}
`;
  }

  if (urgency) {
    prompt += `\n**URGENCY:**
${urgency}
`;
  }

  prompt += `

Please provide a comprehensive answer with the following sections:

1. **DIRECT ANSWER** (2-3 sentences)
   - Clear answer to the question
   - Main regulatory requirement

2. **LEGAL BASIS**
   - Relevant Kenyan laws and regulations
   - Specific sections and clauses
   - Regulatory authorities

3. **COMPLIANCE REQUIREMENTS**
   - What must be done
   - Documentation needed
   - Processes to implement
   - Systems/controls required

4. **IMPLEMENTATION GUIDANCE**
   - Step-by-step actions
   - Practical considerations
   - Common pitfalls to avoid
   - Best practices

5. **TIMELINE**
   - When compliance is required
   - Any grace periods
   - Ongoing obligations

6. **NON-COMPLIANCE CONSEQUENCES**
   - Penalties and fines
   - Other sanctions
   - Reputational risks

7. **RELATED CONSIDERATIONS**
   - Connected regulatory requirements
   - Upcoming regulatory changes
   - Industry-specific nuances

Format your response clearly with headers and bullet points. Cite specific laws and regulations.`;

  return prompt;
}

/**
 * Generate prompt for follow-up query
 */
export function generateFollowUpQueryPrompt(
  originalQuestion: string,
  originalAnswer: string,
  followUpQuestion: string
): string {
  return `You previously answered a compliance question. The user has a follow-up question.

**ORIGINAL QUESTION:**
${originalQuestion}

**YOUR PREVIOUS ANSWER:**
${originalAnswer}

**FOLLOW-UP QUESTION:**
${followUpQuestion}

Please answer the follow-up question while:
1. Building on your previous answer
2. Maintaining consistency
3. Providing any additional legal citations needed
4. Clarifying or expanding as requested

Keep the same professional format and citation style.`;
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
 * Extract answer sections from AI response
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
  const sections = {
    directAnswer: '',
    legalBasis: '',
    requirements: '',
    guidance: '',
    timeline: '',
    consequences: '',
    relatedConsiderations: '',
    citations: [] as string[],
  };

  // Extract direct answer
  const directMatch = response.match(/\*\*DIRECT ANSWER\*\*([\s\S]*?)(?=\*\*[A-Z]|$)/i);
  if (directMatch) {
    sections.directAnswer = directMatch[1].trim();
  }

  // Extract legal basis
  const legalMatch = response.match(/\*\*LEGAL BASIS\*\*([\s\S]*?)(?=\*\*[A-Z]|$)/i);
  if (legalMatch) {
    sections.legalBasis = legalMatch[1].trim();
  }

  // Extract requirements
  const reqMatch = response.match(/\*\*COMPLIANCE REQUIREMENTS\*\*([\s\S]*?)(?=\*\*[A-Z]|$)/i);
  if (reqMatch) {
    sections.requirements = reqMatch[1].trim();
  }

  // Extract guidance
  const guideMatch = response.match(/\*\*IMPLEMENTATION GUIDANCE\*\*([\s\S]*?)(?=\*\*[A-Z]|$)/i);
  if (guideMatch) {
    sections.guidance = guideMatch[1].trim();
  }

  // Extract timeline
  const timeMatch = response.match(/\*\*TIMELINE\*\*([\s\S]*?)(?=\*\*[A-Z]|$)/i);
  if (timeMatch) {
    sections.timeline = timeMatch[1].trim();
  }

  // Extract consequences
  const consMatch = response.match(/\*\*NON-COMPLIANCE CONSEQUENCES\*\*([\s\S]*?)(?=\*\*[A-Z]|$)/i);
  if (consMatch) {
    sections.consequences = consMatch[1].trim();
  }

  // Extract related considerations
  const relatedMatch = response.match(/\*\*RELATED CONSIDERATIONS\*\*([\s\S]*?)(?=\*\*[A-Z]|$)/i);
  if (relatedMatch) {
    sections.relatedConsiderations = relatedMatch[1].trim();
  }

  // Extract citations
  const citationRegex = /([A-Z][A-Za-z\s]+Act\s+\d{4}(?:,\s+Section\s+\d+(?:\([a-z0-9]+\))?)?|[A-Z][A-Za-z\s]+Regulations\s+\d{4})/g;
  const matches = response.match(citationRegex);
  if (matches) {
    sections.citations = [...new Set(matches)];
  }

  return sections;
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