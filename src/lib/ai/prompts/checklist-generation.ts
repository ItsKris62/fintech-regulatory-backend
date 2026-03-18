/**
 * Compliance Checklist Generation Prompts
 * AI prompts for generating RAG-grounded compliance checklists
 * for Kenyan fintech regulatory requirements.
 */

import { z } from 'zod';

// ─── Input Types ────────────────────────────────────────────────────────────

export interface ChecklistGenerationParams {
  productType: string;
  businessStage: string;
  targetSegments: string[];
  servicesOffered: string[];
  additionalConcerns?: string;
  ragContext?: string;     // Retrieved regulatory context from Pinecone
  ragSourcesUsed?: number; // Number of RAG chunks retrieved (for metadata)
}

// ─── Zod Schemas (strict validation of Claude API output) ────────────────────
// These are the single source of truth for the AI response shape.
// parseChecklistOutput() must pass raw Claude output through these schemas
// before any DB write — malformed AI responses must never reach Prisma.

export const ChecklistItemSchema = z.object({
  /** AI-generated label (e.g. "LIC-001"). Not persisted — DB generates its own IDs. */
  id:               z.string().optional(),
  title:            z.string().min(1, 'Item title must not be empty'),
  regulatoryBasis:  z.string().min(1, 'Regulatory basis must not be empty'),
  priority:         z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
  description:      z.string().min(1, 'Item description must not be empty'),
  /** Optional 1-2 sentence guidance note specific to this business profile. */
  guidance:         z.string().optional(),
  actionItems:      z.array(z.string()).default([]),
  deadline:         z.string().default(''),
  penalty:          z.string().default(''),
});

export const ChecklistCategorySchema = z.object({
  /** AI-generated short label (e.g. "LIC"). Not persisted. */
  id:          z.string().optional(),
  name:        z.string().min(1, 'Category name must not be empty'),
  description: z.string(),
  items:       z.array(ChecklistItemSchema).min(1, 'Each category must have at least one item'),
});

export const GeneratedChecklistSchema = z.object({
  categories: z.array(ChecklistCategorySchema).min(1, 'Response must contain at least one category'),
  metadata: z.object({
    productType:             z.string(),
    businessStage:           z.string(),
    totalItems:              z.number(),
    criticalItems:           z.number(),
    highItems:               z.number(),
    estimatedCompletionDays: z.number(),
    generatedAt:             z.string(),
    ragSourcesUsed:          z.number(),
  }),
});

// ─── Inferred Output Types (derived from Zod schemas) ────────────────────────

export type ChecklistItem     = z.infer<typeof ChecklistItemSchema>;
export type ChecklistCategory = z.infer<typeof ChecklistCategorySchema>;
export type GeneratedChecklist = z.infer<typeof GeneratedChecklistSchema>;

// ─── Prompt Builders ─────────────────────────────────────────────────────────

/**
 * System prompt establishing the AI persona and output contract.
 */
export function generateChecklistSystemPrompt(): string {
  return `You are a senior regulatory compliance expert specializing in Kenya's financial services sector with 15+ years of experience. You have deep expertise in:

KENYAN LEGISLATION:
- Data Protection Act 2019 (DPA) and Office of the Data Protection Commissioner (ODPC) guidelines
- National Payment System Act 2011 (NPSA) and CBK Payment Service Provider Regulations
- Proceeds of Crime and Anti-Money Laundering Act (POCAMLA) and AML/CFT regulations
- Digital Credit Providers Regulations 2022 (Gazette Notice No. 3416)
- CBK Act (Cap 491) — licensing, supervision, and prudential requirements
- Computer Misuse and Cybercrimes Act 2018
- Consumer Protection Act 2012 and CBK Consumer Protection Guidelines
- Capital Markets Act (Cap 485A) and CMA Investment-Based Crowdfunding Regulations
- Insurance Act (Cap 487) and IRA guidelines
- CBK Prudential Guidelines for Institutions Licensed under the Banking Act
- CBK Guidance Note on Cybersecurity (March 2023)
- Kenya Revenue Authority digital services tax and VAT obligations

REGULATORS:
Central Bank of Kenya (CBK), Capital Markets Authority (CMA), Insurance Regulatory Authority (IRA),
Office of the Data Protection Commissioner (ODPC), Financial Reporting Centre (FRC),
Communications Authority of Kenya (CA), Kenya Revenue Authority (KRA)

OUTPUT RULES — FOLLOW EXACTLY:
1. Respond ONLY with valid JSON. No markdown fences, no preamble, no trailing text. Start with { and end with }.
2. Every checklist item MUST cite a specific Kenyan law, regulation, or guideline with the section number.
3. Penalties MUST include specific amounts in Kenya Shillings (KES) where defined in the legislation.
4. Action items must be specific and actionable (not vague). Bad: "Ensure compliance". Good: "Submit PSP licence application to CBK via the eCitizen portal with Form CBK/PG/01 and all annexures".
5. Deadlines must be specific: "Before commencing operations", "Within 30 days of [event]", "Annually by 31 March", etc.
6. Do not hallucinate laws or section numbers. If uncertain about a specific section, cite the parent law and regulation.
7. Generate a MINIMUM of 30 checklist items across at least 7 categories for any fintech product.
8. Priority: CRITICAL = CBK licence/registration or legal prohibition (operations cannot start without this); HIGH = required within 3 months; MEDIUM = required within 6 months; LOW = best practice or compliance within 12 months.
9. Each item MAY include an optional "guidance" field (1–2 sentences) explaining WHY this requirement is specifically relevant to the business profile provided. Omit this field rather than stating the obvious.`;
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
          "guidance": "As a digital lending platform targeting retail consumers, this is your highest-priority blocker — CBK has been enforcing this requirement strictly since mid-2023.",
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
    "ragSourcesUsed": ${params.ragSourcesUsed ?? (params.ragContext ? 1 : 0)}
  }
}
\`\`\`

QUALITY REQUIREMENTS:
- Generate 5-8 items per applicable category (skip only genuinely inapplicable categories)
- Minimum 30 items total across all categories
- Every item needs a complete regulatory citation, description, 3-5 action steps, deadline, and penalty
- Add a "guidance" field to items where this requirement has specific relevance to the stated product type, target segments, or services offered — not for generic items
- Prioritize accuracy over brevity — every item must be traceable to real Kenyan law
- For estimatedCompletionDays: pre-launch startups typically need 120-180 days; operational companies 60-90 days

After generating all items, count them and populate metadata.totalItems, metadata.criticalItems, and metadata.highItems with the actual counts.

Return ONLY valid JSON. Start with { and end with }. No other text.`;
}

/**
 * Parse and strictly validate AI checklist output via Zod.
 *
 * Pipeline:
 *  1. Strip markdown code fences (Claude sometimes adds them despite instructions).
 *  2. JSON.parse() — throw if not valid JSON.
 *  3. GeneratedChecklistSchema.parse() — throw ZodError with field-level detail
 *     if the shape is wrong.  This is the P0 guard against corrupt DB writes.
 *  4. Recompute metadata counts from actual item data (override AI-reported counts).
 *
 * Throws an Error with a descriptive message on any failure.
 * Callers (checklist.service.ts) must catch and mark the checklist FAILED.
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

  // JSON parse — attempt a fallback extraction if the model added leading text
  let rawParsed: unknown;
  try {
    rawParsed = JSON.parse(content);
  } catch {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('AI response does not contain valid JSON');
    }
    try {
      rawParsed = JSON.parse(jsonMatch[0]);
    } catch (innerErr: unknown) {
      throw new Error(
        `AI response contains malformed JSON: ${(innerErr as Error).message}`
      );
    }
  }

  // Strict Zod validation — throws ZodError with field paths on schema mismatch
  const result = GeneratedChecklistSchema.safeParse(rawParsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`AI response failed schema validation: ${issues}`);
  }

  const parsed = result.data;

  // Recompute metadata counts from actual items — never trust the AI's self-reported counts
  let totalItems    = 0;
  let criticalItems = 0;
  let highItems     = 0;

  for (const category of parsed.categories) {
    totalItems += category.items.length;
    for (const item of category.items) {
      if (item.priority === 'CRITICAL') criticalItems++;
      if (item.priority === 'HIGH')     highItems++;
    }
  }

  parsed.metadata.totalItems    = totalItems;
  parsed.metadata.criticalItems = criticalItems;
  parsed.metadata.highItems     = highItems;
  parsed.metadata.generatedAt   = new Date().toISOString();

  return parsed;
}
