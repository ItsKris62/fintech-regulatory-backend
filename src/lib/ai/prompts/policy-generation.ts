/**
 * Policy Generation Prompt Templates
 * Generates comprehensive policy frameworks based on Kenyan regulations
 */

/**
 * Policy generation request parameters
 */
export interface PolicyGenerationParams {
  scenario: string;
  organizationType: 'FINTECH' | 'BANK' | 'TELECOM' | 'INSURANCE' | 'OTHER';
  regulatoryAreas: string[];
  specificRequirements?: string;
  targetAudience?: string;
  existingPolicies?: string;
}

/**
 * Generate system prompt for policy generation
 */
export function generatePolicySystemPrompt(): string {
  return `You are an expert AI assistant specializing in Kenyan regulatory compliance and policy framework development. Your role is to help regulators and organizations create comprehensive, legally sound policy frameworks based on Kenya's laws and regulations.

EXPERTISE AREAS:
- Kenya's legal and regulatory framework
- Data Protection Act 2019 and GDPR alignment
- Digital lending and fintech regulations
- Central Bank of Kenya (CBK) regulations
- National Payment Systems (NPS) regulations
- Anti-Money Laundering (AML) and Counter-Terrorism Financing (CTF)
- Know Your Customer (KYC) requirements
- Consumer protection laws
- Banking and financial services regulations
- Telecommunications regulations

OUTPUT REQUIREMENTS:
1. **Executive Summary**: Brief overview of the policy framework
2. **Regulatory Analysis**: Relevant Kenyan laws and regulations with specific citations
3. **Policy Recommendations**: Detailed, actionable policy recommendations
4. **Compliance Checklist**: Step-by-step compliance requirements
5. **Legal Citations**: Exact references to laws, acts, and regulations

CITATION FORMAT:
- Always cite specific sections of acts (e.g., "Data Protection Act 2019, Section 25(1)")
- Reference specific regulations (e.g., "CBK Prudential Guidelines 2013, Clause 4.2")
- Include regulation numbers and dates
- Link recommendations to specific legal requirements

WRITING STYLE:
- Professional and formal tone
- Clear, actionable language
- Kenyan legal terminology
- Structured and well-organized
- Use bullet points and numbered lists for clarity

IMPORTANT:
- Only cite laws and regulations that actually exist in Kenya
- Be specific with section numbers and clauses
- Distinguish between mandatory requirements and best practices
- Consider the Kenyan business and regulatory environment
- Address practical implementation challenges`;
}

/**
 * Generate user prompt for policy generation
 */
export function generatePolicyUserPrompt(params: PolicyGenerationParams): string {
  const { scenario, organizationType, regulatoryAreas, specificRequirements, targetAudience, existingPolicies } = params;

  let prompt = `Generate a comprehensive policy framework for the following scenario:

**SCENARIO:**
${scenario}

**ORGANIZATION TYPE:**
${organizationType}

**REGULATORY AREAS TO COVER:**
${regulatoryAreas.map((area, i) => `${i + 1}. ${area}`).join('\n')}
`;

  if (specificRequirements) {
    prompt += `\n**SPECIFIC REQUIREMENTS:**
${specificRequirements}
`;
  }

  if (targetAudience) {
    prompt += `\n**TARGET AUDIENCE:**
${targetAudience}
`;
  }

  if (existingPolicies) {
    prompt += `\n**EXISTING POLICIES TO CONSIDER:**
${existingPolicies}
`;
  }

  prompt += `

**DELIVERABLES:**

Please provide a comprehensive policy framework with the following sections:

1. **EXECUTIVE SUMMARY** (2-3 paragraphs)
   - Overview of the policy framework
   - Key regulatory obligations
   - Summary of main recommendations

2. **REGULATORY LANDSCAPE**
   - Relevant Kenyan laws and regulations
   - Specific sections and clauses that apply
   - Regulatory authorities with jurisdiction
   - Recent regulatory changes or updates

3. **DETAILED POLICY RECOMMENDATIONS**
   For each regulatory area, provide:
   - Policy objective
   - Legal basis (with citations)
   - Specific recommendations
   - Implementation guidance
   - Compliance timeline

4. **COMPLIANCE CHECKLIST**
   A step-by-step checklist organized by:
   - Immediate actions (0-30 days)
   - Short-term actions (1-3 months)
   - Medium-term actions (3-6 months)
   - Ongoing compliance requirements

5. **RISK ASSESSMENT**
   - Key compliance risks
   - Penalties for non-compliance
   - Mitigation strategies

6. **IMPLEMENTATION ROADMAP**
   - Timeline for implementation
   - Responsible parties
   - Resources required
   - Success metrics

7. **LEGAL CITATIONS APPENDIX**
   Complete list of all referenced laws, acts, and regulations with:
   - Full act/regulation name
   - Section/clause numbers
   - Brief description of relevance

IMPORTANT INSTRUCTIONS:
- Use ONLY Kenyan laws and regulations
- Provide specific citations (e.g., "Data Protection Act 2019, Section 25")
- Consider the practical Kenyan business context
- Flag any uncertainties or areas requiring legal review
- Make recommendations specific and actionable
- Use professional regulatory language`;

  return prompt;
}

/**
 * Generate prompt for policy refinement
 */
export function generatePolicyRefinementPrompt(
  originalPolicy: string,
  refinementInstructions: string
): string {
  return `You are reviewing and refining a policy framework based on additional instructions.

**ORIGINAL POLICY FRAMEWORK:**
${originalPolicy}

**REFINEMENT INSTRUCTIONS:**
${refinementInstructions}

Please update the policy framework according to the instructions while:
1. Maintaining all accurate legal citations
2. Preserving the overall structure
3. Adding any new regulatory considerations
4. Ensuring consistency throughout
5. Highlighting what has changed

Provide the COMPLETE updated policy framework with all sections.`;
}

/**
 * Generate prompt for citation verification
 */
export function generateCitationVerificationPrompt(citations: string[]): string {
  return `Review the following legal citations from a policy framework and verify their accuracy:

**CITATIONS TO VERIFY:**
${citations.map((citation, i) => `${i + 1}. ${citation}`).join('\n')}

For each citation, indicate:
- ✓ CORRECT: Citation is accurate and properly formatted
- ⚠ WARNING: Citation exists but may have minor formatting issues
- ✗ INCORRECT: Citation appears to be inaccurate or doesn't exist

Provide a brief explanation for any warnings or errors, including:
- Correct section/clause numbers if different
- Proper act/regulation name if different
- Whether the law/regulation exists in Kenya

Format your response as:
[Number]. [✓/⚠/✗] [Citation] - [Explanation if needed]`;
}

/**
 * Extract policy sections from AI response
 */
export function extractPolicySections(response: string): {
  executiveSummary: string;
  regulatoryLandscape: string;
  recommendations: string;
  complianceChecklist: string;
  riskAssessment: string;
  implementationRoadmap: string;
  citations: string[];
} {
  const sections = {
    executiveSummary: '',
    regulatoryLandscape: '',
    recommendations: '',
    complianceChecklist: '',
    riskAssessment: '',
    implementationRoadmap: '',
    citations: [] as string[],
  };

  // Extract executive summary
  const execMatch = response.match(/\*\*EXECUTIVE SUMMARY\*\*([\s\S]*?)(?=\*\*[A-Z]|$)/i);
  if (execMatch) {
    sections.executiveSummary = execMatch[1].trim();
  }

  // Extract regulatory landscape
  const regMatch = response.match(/\*\*REGULATORY LANDSCAPE\*\*([\s\S]*?)(?=\*\*[A-Z]|$)/i);
  if (regMatch) {
    sections.regulatoryLandscape = regMatch[1].trim();
  }

  // Extract recommendations
  const recMatch = response.match(/\*\*DETAILED POLICY RECOMMENDATIONS\*\*([\s\S]*?)(?=\*\*[A-Z]|$)/i);
  if (recMatch) {
    sections.recommendations = recMatch[1].trim();
  }

  // Extract compliance checklist
  const checkMatch = response.match(/\*\*COMPLIANCE CHECKLIST\*\*([\s\S]*?)(?=\*\*[A-Z]|$)/i);
  if (checkMatch) {
    sections.complianceChecklist = checkMatch[1].trim();
  }

  // Extract risk assessment
  const riskMatch = response.match(/\*\*RISK ASSESSMENT\*\*([\s\S]*?)(?=\*\*[A-Z]|$)/i);
  if (riskMatch) {
    sections.riskAssessment = riskMatch[1].trim();
  }

  // Extract implementation roadmap
  const implMatch = response.match(/\*\*IMPLEMENTATION ROADMAP\*\*([\s\S]*?)(?=\*\*[A-Z]|$)/i);
  if (implMatch) {
    sections.implementationRoadmap = implMatch[1].trim();
  }

  // Extract citations
  const citationRegex = /([A-Z][A-Za-z\s]+Act\s+\d{4}(?:,\s+Section\s+\d+(?:\([a-z0-9]+\))?)?)/g;
  const matches = response.match(citationRegex);
  if (matches) {
    sections.citations = [...new Set(matches)]; // Remove duplicates
  }

  return sections;
}

/**
 * Generate follow-up questions prompt
 */
export function generateFollowUpQuestionsPrompt(policyContent: string): string {
  return `Based on this policy framework, generate 3-5 follow-up questions that would help refine or expand the policy:

**POLICY FRAMEWORK:**
${policyContent.substring(0, 2000)}... [truncated]

Generate questions that:
1. Identify areas needing more detail
2. Clarify ambiguous recommendations
3. Address potential implementation challenges
4. Consider edge cases or special circumstances
5. Explore additional regulatory considerations

Format as numbered questions (1-5).`;
}