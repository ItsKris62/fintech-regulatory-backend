/**
 * Compliance Checklist Generation Prompts
 * AI prompts for generating RAG-grounded compliance checklists
 * for Kenyan fintech regulatory requirements.
 */

// ─── Input Types ────────────────────────────────────────────────────────────

export interface ChecklistGenerationParams {
  productType: string;
  businessStage: string;
  targetSegments: string[];
  servicesOffered: string[];
  additionalConcerns?: string;
  ragContext?: string; // Retrieved regulatory context from Pinecone
}

// ─── Output Types ────────────────────────────────────────────────────────────

export interface ChecklistItem {
  id: string;
  title: string;
  regulatoryBasis: string;
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  description: string;
  actionItems: string[];
  deadline: string;
  penalty: string;
}

export interface ChecklistCategory {
  id: string;
  name: string;
  description: string;
  items: ChecklistItem[];
}

export interface GeneratedChecklist {
  categories: ChecklistCategory[];
  metadata: {
    productType: string;
    businessStage: string;
    totalItems: number;
    criticalItems: number;
    highItems: number;
    estimatedCompletionDays: number;
    generatedAt: string;
    ragSourcesUsed: number;
  };
}

// ─── Prompt Builders ─────────────────────────────────────────────────────────

/**
 * System prompt establishing the AI persona and output contract.
 */
export function generateChecklistSystemPrompt(): string {
  return `You are a senior Kenyan fintech regulatory compliance expert with deep expertise in:
- Central Bank of Kenya (CBK) regulations and prudential guidelines
- Data Protection Act 2019 (DPA) and ODPC guidelines
- Proceeds of Crime and Anti-Money Laundering Act (POCAMLA)
- National Payment System Act 2011 and its regulations
- Computer Misuse and Cybercrimes Act 2018
- Consumer Protection Act and CBK consumer protection guidelines
- Capital Markets Authority (CMA) regulations
- Insurance Regulatory Authority (IRA) guidelines
- Digital Credit Providers Regulations 2022
- CBK Guidance Note on Cybersecurity 2023
- Kenya Revenue Authority (KRA) digital services tax regulations

Your role is to generate comprehensive, accurate compliance checklists grounded in actual Kenyan law. Every requirement must cite the specific regulatory instrument, section, and subsection where the obligation originates.

CRITICAL OUTPUT RULES:
1. Respond ONLY with valid JSON. No markdown fences, no preamble, no explanation outside the JSON.
2. Every checklist item MUST cite a real Kenyan law or regulation with the specific section number.
3. Priority CRITICAL = CBK licence/registration requirement or legal prohibition; HIGH = required within 3 months; MEDIUM = required within 6 months; LOW = best practice or longer-term.
4. Penalties must be the actual statutory penalties from Kenyan law (in KES or years of imprisonment).
5. Do not hallucinate laws or section numbers. If uncertain, use the most relevant known provision.
6. Cover ALL applicable categories for the product type provided.`;
}

/**
 * User prompt with full context for checklist generation.
 */
export function generateChecklistUserPrompt(params: ChecklistGenerationParams): string {
  const ragSection = params.ragContext
    ? `\n\n## RETRIEVED REGULATORY CONTEXT (use these passages to ground your checklist items):\n${params.ragContext}\n`
    : `\n\n## NOTE: Regulatory database context unavailable. Use your knowledge of current Kenyan regulations.\n`;

  return `Generate a comprehensive compliance checklist for the following Kenyan fintech business:

## BUSINESS PROFILE
- **Product/Service Type:** ${params.productType}
- **Business Stage:** ${params.businessStage}
- **Target Customer Segments:** ${params.targetSegments.join(', ')}
- **Services Offered:** ${params.servicesOffered.join(', ')}
${params.additionalConcerns ? `- **Specific Compliance Concerns:** ${params.additionalConcerns}` : ''}
${ragSection}

## REQUIRED CHECKLIST CATEGORIES
Generate items for ALL applicable categories below. Skip any that are genuinely not applicable to this business type (briefly note why in the category description):

1. **Licensing & Registration** — CBK licence, sector-specific registrations, incorporation
2. **Data Protection & Privacy** — DPA 2019, ODPC registration, consent management, data subject rights
3. **AML/KYC/CFT** — POCAMLA, customer due diligence, transaction monitoring, suspicious activity reporting
4. **Consumer Protection** — Disclosure requirements, fair lending, complaint handling, cooling-off periods
5. **Capital & Prudential Requirements** — Minimum capital, reserves, liquidity ratios
6. **Technology & Cybersecurity** — CBK Cybersecurity Guidance Note, incident response, penetration testing
7. **Reporting & Record Keeping** — CBK returns, regulatory filings, record retention periods
8. **Corporate Governance** — Board requirements, key personnel, fit-and-proper criteria
9. **Outsourcing & Third-Party Management** — Vendor due diligence, CBK outsourcing policy
10. **Business Continuity & Disaster Recovery** — BCP requirements, RPO/RTO targets
11. **Complaints Handling & Dispute Resolution** — Internal mechanisms, CBK escalation procedures
12. **Tax Compliance** — Digital Services Tax, VAT, withholding tax, KRA obligations
13. **Foreign Exchange Compliance** — (include only if FX/remittance services offered)

## REQUIRED JSON SCHEMA
Return exactly this structure:

\`\`\`json
{
  "categories": [
    {
      "id": "LIC",
      "name": "Licensing & Registration",
      "description": "Core licensing requirements for operating legally in Kenya",
      "items": [
        {
          "id": "LIC-001",
          "title": "Apply for CBK Digital Credit Provider Authorisation",
          "regulatoryBasis": "Digital Credit Providers Regulations, 2022, Regulation 4(1)",
          "priority": "CRITICAL",
          "description": "All digital credit providers must obtain CBK authorisation before commencing operations. Application must be submitted via CBK portal with all supporting documents.",
          "actionItems": [
            "Prepare application form as per CBK Digital Credit Provider Registration guidelines",
            "Compile required documents: Certificate of incorporation, memorandum and articles, audited financials, business plan, technology assessment",
            "Pay application fee of KES 5,000 as per CBK fee schedule",
            "Await CBK review (typically 60-90 days)"
          ],
          "deadline": "Before commencement of lending operations",
          "penalty": "Fine not exceeding KES 10,000,000 or imprisonment not exceeding 5 years, or both — Digital Credit Providers Regulations 2022, Regulation 36"
        }
      ]
    }
  ],
  "metadata": {
    "productType": "${params.productType}",
    "businessStage": "${params.businessStage}",
    "totalItems": 0,
    "criticalItems": 0,
    "highItems": 0,
    "estimatedCompletionDays": 90,
    "generatedAt": "${new Date().toISOString()}",
    "ragSourcesUsed": ${params.ragContext ? 1 : 0}
  }
}
\`\`\`

Populate the actual metadata counts after generating all items. Generate 5-10 items per applicable category. Be specific, actionable, and cite exact Kenyan law sections. Return ONLY valid JSON.`;
}

/**
 * Parse and validate AI checklist output.
 * Strips markdown fences, handles malformed JSON, validates structure.
 */
export function parseChecklistOutput(rawContent: string): GeneratedChecklist {
  let content = rawContent.trim();

  // Strip markdown code fences if present
  if (content.startsWith('```')) {
    content = content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
  }

  let parsed: GeneratedChecklist;
  try {
    parsed = JSON.parse(content) as GeneratedChecklist;
  } catch {
    // Try to extract JSON object from the content
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('AI response does not contain valid JSON');
    }
    parsed = JSON.parse(jsonMatch[0]) as GeneratedChecklist;
  }

  // Validate required structure
  if (!parsed.categories || !Array.isArray(parsed.categories)) {
    throw new Error('Invalid checklist structure: missing categories array');
  }
  if (!parsed.metadata) {
    throw new Error('Invalid checklist structure: missing metadata');
  }

  // Recompute metadata counts from actual items
  let totalItems = 0;
  let criticalItems = 0;
  let highItems = 0;

  for (const category of parsed.categories) {
    if (!Array.isArray(category.items)) continue;
    totalItems += category.items.length;
    for (const item of category.items) {
      if (item.priority === 'CRITICAL') criticalItems++;
      if (item.priority === 'HIGH') highItems++;
    }
  }

  parsed.metadata.totalItems = totalItems;
  parsed.metadata.criticalItems = criticalItems;
  parsed.metadata.highItems = highItems;
  parsed.metadata.generatedAt = new Date().toISOString();

  return parsed;
}
