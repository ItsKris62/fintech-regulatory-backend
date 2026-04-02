/**
 * Compliance Checklist Generation Prompts
 * AI prompts for generating RAG-grounded compliance checklists
 * for Kenyan fintech regulatory requirements.
 */

import { z } from 'zod';
import { logger } from '@/utils/logger';

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
  /** AI-generated label (e.g. "LIC-001"). Persisted as itemCode on ChecklistItem. */
  id:               z.string().optional(),
  title:            z.string().min(5, 'Item title must be descriptive (min 5 chars)'),
  regulatoryBasis:  z.string().min(5, 'Regulatory basis must cite a specific law or regulation'),
  priority:         z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
  description:      z.string().min(20, 'Item description must be substantive (min 20 chars)'),
  /** Optional 1-2 sentence guidance note specific to this business profile. */
  guidance:         z.string().optional(),
  actionItems:      z.array(z.string().min(10)).min(1, 'Each item must have at least one action step').default([]),
  deadline:         z.string().min(3, 'Deadline must be specified').default('As soon as practicable'),
  penalty:          z.string().min(5, 'Penalty must be specified').default('Refer to relevant regulation'),
});

export const ChecklistCategorySchema = z.object({
  /** AI-generated short label (e.g. "LIC"). Persisted as category name on ChecklistItem rows. */
  id:          z.string().optional(),
  name:        z.string().min(3, 'Category name must not be empty'),
  description: z.string().min(10, 'Category description must be substantive'),
  items:       z.array(ChecklistItemSchema).min(1, 'Each category must have at least one item'),
});

export const GeneratedChecklistSchema = z.object({
  categories: z.array(ChecklistCategorySchema).min(5, 'Response must contain at least 5 categories'),
  metadata: z.object({
    productType:             z.string(),
    businessStage:           z.string(),
    totalItems:              z.number().int().min(0),
    criticalItems:           z.number().int().min(0),
    highItems:               z.number().int().min(0),
    estimatedCompletionDays: z.number().int().positive(),
    generatedAt:             z.string(),
    ragSourcesUsed:          z.number().int().min(0),
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
  return `You are SheriaBot, a senior regulatory compliance advisor specializing in Kenya's fintech sector with 15+ years of experience advising CBK-licensed institutions, digital lenders, payment service providers, and insurtech companies. You have deep expertise in:

KENYAN LEGISLATION:
- Data Protection Act 2019 (DPA) and Office of the Data Protection Commissioner (ODPC) guidelines
- National Payment System Act 2011 (NPSA) and CBK Payment Service Provider (PSP) Regulations
- Proceeds of Crime and Anti-Money Laundering Act (POCAMLA) and AML/CFT regulations
- Digital Credit Providers Regulations 2022 (Gazette Notice No. 3416)
- CBK Act (Cap 491) — licensing, supervision, and prudential requirements
- Computer Misuse and Cybercrimes Act 2018
- Consumer Protection Act 2012 and CBK Consumer Protection Guidelines
- Capital Markets Act (Cap 485A) and CMA Investment-Based Crowdfunding Regulations 2022
- Insurance Act (Cap 487) and IRA guidelines
- CBK Prudential Guidelines for Institutions Licensed under the Banking Act
- CBK Guidance Note on Cybersecurity (March 2023)
- Micro and Small Enterprises Act 2012 (relevant for SACCO/microfinance)
- SACCO Societies Act 2008 and SASRA Regulations
- Kenya Revenue Authority: Digital Services Tax, VAT Act (Cap 476), withholding tax obligations
- Foreign Exchange (Forex) Act and CBK forex dealer regulations
- Business Registration Service Act 2015 (incorporation requirements)

REGULATORS:
Central Bank of Kenya (CBK), Capital Markets Authority (CMA), Insurance Regulatory Authority (IRA),
Office of the Data Protection Commissioner (ODPC), Financial Reporting Centre (FRC),
Communications Authority of Kenya (CA), Kenya Revenue Authority (KRA),
SACCO Societies Regulatory Authority (SASRA), Competition Authority of Kenya (CAK)

INTERNATIONAL STANDARDS (apply where relevant):
ISO 27001 (information security), PCI-DSS (payment card data), FATF Recommendations (AML/CFT),
Basel III (capital adequacy for banking-adjacent products)

OUTPUT RULES — FOLLOW EXACTLY:
1. Respond ONLY with valid JSON. No markdown fences, no preamble, no trailing text. Start with { and end with }.
2. Every checklist item MUST cite a specific Kenyan law, regulation, or guideline with the section number. Do not cite generic "best practice" without a legal anchor.
3. Penalties MUST include specific amounts in Kenya Shillings (KES) where defined in the legislation. Where imprisonment applies, state both the fine and the custodial sentence.
4. Action items must be specific and actionable — describe exactly what to do. Bad: "Ensure compliance with AML laws". Good: "Register with the Financial Reporting Centre (FRC) as a reporting institution by submitting Form FRC/001 via the FRC portal at frc.go.ke, accompanied by your certificate of incorporation, KRA PIN, and a compliance officer appointment letter."
5. Deadlines must be specific and tied to a regulatory event: "Before commencing operations", "Within 30 days of onboarding the first customer", "Annually by 31 March", "Within 60 days of a material change to your systems."
6. Do not hallucinate laws or section numbers. If uncertain about a specific section, cite the parent law and regulation name without inventing a section number.
7. Generate a MINIMUM of 25 checklist items across at least 5 categories. Quality over brevity — regulators and legal teams will rely on this output.
8. Priority must be defensible:
   - CRITICAL = licence/registration blocker or explicit legal prohibition — operations cannot lawfully start without this
   - HIGH = required within 3 months of commencing operations or faces regulatory enforcement
   - MEDIUM = required within 6 months; non-compliance risks regulatory notice
   - LOW = best practice, annual obligation, or compliance horizon beyond 12 months
9. Priority distribution: at least 4 CRITICAL items, at least 6 HIGH items; remainder MEDIUM/LOW.
10. Each item MAY include an optional "guidance" field (1–2 sentences max) explaining WHY this requirement is specifically relevant to the stated business profile. Omit entirely for generic items where the relevance is self-evident.`;
}

/**
 * User prompt with full context for checklist generation.
 */
export function generateChecklistUserPrompt(params: ChecklistGenerationParams): string {
  const ragSection = params.ragContext
    ? `\n\n## RETRIEVED REGULATORY CONTEXT\nThe following passages were retrieved from a database of actual Kenyan regulatory documents. Use these to ground your checklist items in real law — cite the source document and section where applicable:\n\n${params.ragContext}\n`
    : `\n\n## NOTE: Regulatory database context unavailable. Rely on your training knowledge of current Kenyan financial services regulations.\n`;

  return `Generate a comprehensive, professional compliance checklist for the following Kenyan fintech business. This checklist will be used by the company's legal and compliance team and must meet the quality bar of a senior compliance consultant's output.

## BUSINESS PROFILE
- **Product / Service Type:** ${params.productType}
- **Business Stage:** ${params.businessStage}
- **Target Customer Segments:** ${params.targetSegments.join(', ')}
- **Services Offered:** ${params.servicesOffered.join(', ')}
${params.additionalConcerns ? `- **Specific Compliance Concerns:** ${params.additionalConcerns}` : '- **Specific Compliance Concerns:** None provided'}
${ragSection}

## REQUIRED CHECKLIST CATEGORIES
Generate items for ALL applicable categories. Only skip a category if it is genuinely inapplicable to this specific business (note why in the category description). Cover all of these:

1. **Licensing & Registration** — CBK licence/authorisation, sector registrations, FRC registration, incorporation
2. **Data Protection & Privacy** — DPA 2019, ODPC registration, consent framework, data subject rights, cross-border transfer restrictions
3. **AML / KYC / CFT** — POCAMLA obligations, CDD/EDD procedures, PEP screening, transaction monitoring, STR/CTR filing with FRC
4. **Consumer Protection** — Fair dealing, disclosure requirements, cooling-off periods, complaints handling (CBK Consumer Protection Guidelines)
5. **Capital & Prudential Requirements** — Minimum capital thresholds, liquidity requirements, reserve fund obligations
6. **Technology & Cybersecurity** — CBK Cybersecurity Guidance Note 2023, incident response plan, penetration testing, ISO 27001
7. **Reporting & Record Keeping** — Regulatory returns to CBK/CMA/IRA, transaction records, retention periods (POCAMLA: 7 years)
8. **Corporate Governance** — Board composition, fit-and-proper criteria for directors/senior management, ownership disclosure
9. **Outsourcing & Third-Party Risk** — CBK outsourcing policy, vendor due diligence, contractual requirements for subprocessors
10. **Business Continuity & Disaster Recovery** — BCP documentation, RPO/RTO targets, annual BCP testing
11. **Complaints Handling & Dispute Resolution** — Internal complaints procedure, CBK escalation pathway, turnaround time obligations
12. **Tax Compliance** — Digital Services Tax (1.5% of gross transaction value for non-residents), VAT registration, withholding tax, KRA PIN registration
13. **Foreign Exchange & Remittance** — (INCLUDE ONLY if FX, remittance, or cross-border services are offered) CBK forex dealer authorisation, SWIFT membership, cross-border reporting

## REQUIRED JSON STRUCTURE
Return exactly this structure. Do not add any fields not shown here. Do not omit required fields.

{
  "categories": [
    {
      "id": "LIC",
      "name": "Licensing & Registration",
      "description": "Core licensing requirements for operating legally in Kenya's regulated fintech sector.",
      "items": [
        {
          "id": "LIC-001",
          "title": "Obtain CBK Payment Service Provider (PSP) Authorisation",
          "regulatoryBasis": "National Payment System Act 2011, Section 12; CBK Payment Service Provider Regulations 2014, Regulation 4",
          "priority": "CRITICAL",
          "description": "All entities providing payment services (including mobile money, merchant payments, payment aggregation) must obtain PSP authorisation from the Central Bank of Kenya before commencing operations. Unauthorised operation is a criminal offence.",
          "guidance": "As a payment gateway targeting SME merchants, PSP authorisation is your single biggest regulatory blocker. CBK processing times average 90-120 days — begin this application before any commercial launch activity.",
          "actionItems": [
            "Download and complete CBK PSP application form from www.centralbank.go.ke/national-payments-system",
            "Prepare mandatory annexures: certificate of incorporation, memorandum and articles of association, audited financial statements (last 2 years or projections for new entities), IT system security documentation, AML/CFT policy, business continuity plan",
            "Pay non-refundable application fee of KES 10,000 via CBK payment portal",
            "Submit application package to Director, National Payments System, CBK, Haile Selassie Avenue, Nairobi",
            "Respond promptly to any CBK requests for additional information during the review period (typically 60-90 days)"
          ],
          "deadline": "Before commencing any payment service operations",
          "penalty": "Fine not exceeding KES 10,000,000 and/or imprisonment not exceeding 5 years — National Payment System Act 2011, Section 36"
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

## QUALITY REQUIREMENTS — NON-NEGOTIABLE
- **Minimum 25 items total** across at least 5 categories. Aim for 30-40 for complex products.
- **Minimum 3 items per included category.** No stub categories with 1-2 items.
- **Every item MUST have:**
  - \`regulatoryBasis\`: specific act name + section number (not just "various regulations")
  - \`description\`: 2-3 sentences explaining the obligation and its regulatory context
  - \`actionItems\`: 3-5 concrete, executable steps — name specific forms, portals, fees, or documents
  - \`deadline\`: tied to a specific regulatory event or calendar date
  - \`penalty\`: actual penalty from Kenyan law in KES; include imprisonment if applicable
- **Priority must be defensible** — CRITICAL means operations are illegal without it; HIGH means enforcement risk within 3 months
- **Priority distribution:** At least 4 CRITICAL, at least 6 HIGH items across the checklist
- **Guidance field:** Add only where this specific business profile (product type, stage, segments) creates a materially different compliance picture — not for generic items every fintech must do
- **Accuracy over brevity:** Do not invent section numbers. If you know the law but not the exact section, write "Section [confirm with legal counsel]" rather than fabricating a reference
- **Estimating \`estimatedCompletionDays\`:** Pre-launch / regulatory sandbox stage: 150-180 days (licensing queues); operational < 1 year: 90-120 days; established: 60-90 days

After generating all categories and items, count them accurately and populate:
- \`metadata.totalItems\` = exact count of all items across all categories
- \`metadata.criticalItems\` = exact count of items with priority "CRITICAL"
- \`metadata.highItems\` = exact count of items with priority "HIGH"

Return ONLY valid JSON. Start with { and end with }. No other text before or after.`;
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
      logger.error({
        type: 'checklist_parse_no_json',
        rawContentLength: rawContent.length,
        rawContentPreview: rawContent.slice(0, 500),
        rawContentTail: rawContent.slice(-200),
      });
      throw new Error('AI response does not contain valid JSON');
    }
    try {
      rawParsed = JSON.parse(jsonMatch[0]);
    } catch (innerErr: unknown) {
      logger.error({
        type: 'checklist_parse_malformed',
        rawContentLength: rawContent.length,
        rawContentPreview: rawContent.slice(0, 500),
        rawContentTail: rawContent.slice(-200),
        parseError: innerErr instanceof Error ? innerErr.message : String(innerErr),
      });
      throw new Error(
        `AI response contains malformed JSON: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`
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

  // Recompute metadata counts from actual items — never trust the AI's self-reported counts.
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

  // Enforce minimum item count AFTER recomputing so the check reflects
  // actual items, not the AI's self-reported count.
  const MIN_ITEMS = 15; // Soft floor — Zod enforces 5 categories; this catches thin responses
  if (totalItems < MIN_ITEMS) {
    logger.warn({
      type:        'checklist_parse_too_few_items',
      totalItems,
      minItems:    MIN_ITEMS,
      categories:  parsed.categories.length,
    });
    throw new Error(
      `AI generated only ${totalItems} checklist items (minimum ${MIN_ITEMS} required). ` +
      'The response may have been truncated. Please try again.'
    );
  }

  return parsed;
}
