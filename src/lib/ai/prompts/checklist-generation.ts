/**
 * Compliance Checklist Generation Prompts
 * AI prompts for generating RAG-grounded compliance checklists
 * for jurisdiction-scoped fintech regulatory requirements.
 */

import { z } from 'zod';
import { logger } from '@/utils/logger';
import { jurisdictionLabel, type JurisdictionContext } from '@/types/jurisdiction';

// --- Input Types ------------------------------------------------------------

export interface ChecklistGenerationParams {
  productType: string;
  businessStage: string;
  targetSegments: string[];
  servicesOffered: string[];
  additionalConcerns?: string;
  ragContext?: string;     // Retrieved regulatory context from Pinecone
  ragSourcesUsed?: number; // Number of RAG chunks retrieved (for metadata)
  jurisdictionContext?: JurisdictionContext;
}

// --- Zod Schemas (strict validation of Claude API output) --------------------
// These are the single source of truth for the AI response shape.
// parseChecklistOutput() must pass raw Claude output through these schemas
// before any DB write  -  malformed AI responses must never reach Prisma.

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
  categories: z.array(ChecklistCategorySchema).min(3, 'Response must contain at least 3 categories'),
  metadata: z.object({
    productType:             z.string(),
    businessStage:           z.string(),
    totalItems:              z.number().int().min(0),
    criticalItems:           z.number().int().min(0),
    highItems:               z.number().int().min(0),
    estimatedCompletionDays: z.number().int().positive(),
    generatedAt:             z.string(),
    ragSourcesUsed:          z.number().int().min(0),
    generationStatus:        z.enum(['COMPLETE', 'PARTIAL', 'FAILED']).default('COMPLETE'),
    generationComplete:      z.boolean().default(true),
    expectedCategories:      z.number().int().min(0).optional(),
    completedCategories:     z.number().int().min(0).optional(),
    truncated:               z.boolean().default(false),
  }),
});

// --- Inferred Output Types (derived from Zod schemas) ------------------------

export type ChecklistItem     = z.infer<typeof ChecklistItemSchema>;
export type ChecklistCategory = z.infer<typeof ChecklistCategorySchema>;
export type GeneratedChecklist = z.infer<typeof GeneratedChecklistSchema>;

// --- Prompt Builders ---------------------------------------------------------

/**
 * System prompt establishing the AI persona and output contract.
 */
export function generateChecklistSystemPrompt(jurisdictionContext?: JurisdictionContext): string {
  if (jurisdictionContext) {
    const jurisdictionName = jurisdictionContext.mode === 'SINGLE'
      ? jurisdictionLabel(jurisdictionContext.primaryJurisdiction)
      : jurisdictionContext.jurisdictions.map(jurisdictionLabel).join(', ');
    const jurisdictionCodes = jurisdictionContext.jurisdictions.join(', ');

    return `You are SheriaBot, a senior regulatory compliance advisor specializing in financial-services compliance for ${jurisdictionName}.

AUTHORIZED JURISDICTION:
- Jurisdiction: ${jurisdictionName}
- Country code(s): ${jurisdictionCodes}
- Regulatory corpus scope: ${jurisdictionCodes}

OUTPUT RULES  -  FOLLOW EXACTLY:
1. Respond ONLY with valid JSON. No markdown fences, no preamble, no trailing text. Start with { and end with }.
2. Every legal checklist item MUST be grounded in the retrieved regulatory context for the authorized jurisdiction. Do not rely on model memory as a source of law.
3. Do not cite a law, regulator, section, penalty, threshold, deadline, licence, or filing requirement unless it appears in the retrieved evidence.
4. Reject wrong-country assumptions. Kenya examples apply only when KE is the authorized jurisdiction and the evidence supports them.
5. Action items must be specific and practical, but legal claims must stay tied to retrieved evidence.
6. If source context is insufficient, do not fabricate legal obligations; provide only non-legal operational source-selection next steps.
7. Generate 10 to 15 concise, high-value checklist items across 3 to 5 relevant categories when evidence supports that scope.
8. Priority must be defensible:
   - CRITICAL = licence/registration blocker or explicit legal prohibition
   - HIGH = required near launch or faces regulatory enforcement
   - MEDIUM = required ongoing controls or periodic compliance
   - LOW = lower-risk operational task or best practice supported by evidence

ANTI-TRUNCATION PROTOCOL:
If you approach the response limit, finish the current JSON object, close all arrays/objects, emit accurate metadata, and stop with valid JSON.`;
  }

  throw new Error('HOME_JURISDICTION_REQUIRED');

  return `You are SheriaBot, a senior regulatory compliance advisor specializing in Kenya's fintech sector with 15+ years of experience advising CBK-licensed institutions, digital lenders, payment service providers, and insurtech companies. You have deep expertise in:

KENYAN LEGISLATION:
- Data Protection Act 2019 (DPA) and Office of the Data Protection Commissioner (ODPC) guidelines
- National Payment System Act 2011 (NPSA) and CBK Payment Service Provider (PSP) Regulations
- Proceeds of Crime and Anti-Money Laundering Act (POCAMLA) and AML/CFT regulations
- Digital Credit Providers Regulations 2022 (Gazette Notice No. 3416)
- CBK Act (Cap 491)  -  licensing, supervision, and prudential requirements
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

OUTPUT RULES  -  FOLLOW EXACTLY:
1. Respond ONLY with valid JSON. No markdown fences, no preamble, no trailing text. Start with { and end with }.
2. Every checklist item MUST cite a specific Kenyan law, regulation, or guideline with the section number. Do not cite generic "best practice" without a legal anchor.
3. Penalties MUST include specific amounts in Kenya Shillings (KES) where defined in the legislation. Where imprisonment applies, state both the fine and the custodial sentence.
4. Action items must be specific and actionable  -  describe exactly what to do. Bad: "Ensure compliance with AML laws". Good: "Register with the Financial Reporting Centre (FRC) as a reporting institution by submitting Form FRC/001 via the FRC portal at frc.go.ke, accompanied by your certificate of incorporation, KRA PIN, and a compliance officer appointment letter."
5. Deadlines must be specific and tied to a regulatory event: "Before commencing operations", "Within 30 days of onboarding the first customer", "Annually by 31 March", "Within 60 days of a material change to your systems."
6. Do not hallucinate laws or section numbers. If uncertain about a specific section, cite the parent law and regulation name without inventing a section number.
7. Generate a MINIMUM of 25 checklist items across at least 5 categories. Quality over brevity  -  regulators and legal teams will rely on this output.
8. Priority must be defensible:
   - CRITICAL = licence/registration blocker or explicit legal prohibition  -  operations cannot lawfully start without this
   - HIGH = required within 3 months of commencing operations or faces regulatory enforcement
   - MEDIUM = required within 6 months; non-compliance risks regulatory notice
   - LOW = best practice, annual obligation, or compliance horizon beyond 12 months
9. Priority distribution: at least 4 CRITICAL items, at least 6 HIGH items; remainder MEDIUM/LOW.
10. Each item MAY include an optional "guidance" field (1-2 sentences max) explaining WHY this requirement is specifically relevant to the stated business profile. Omit entirely for generic items where the relevance is self-evident.

ANTI-TRUNCATION PROTOCOL  -  FOLLOW IF APPROACHING TOKEN LIMIT:
If you sense you are near your response limit before completing all categories:
  a) Finish the current item's last field value completely  -  never stop mid-string.
  b) Close the current item object: }
  c) Close the items array: ]
  d) Close the current category object: }
  e) Close the categories array: ]
  f) Emit a valid metadata block with accurate totalItems, criticalItems, highItems counts based on what you have written.
  g) Close the root object: }
A valid partial JSON with 5 well-formed categories is far more useful than a truncated response with 13 broken categories.
NEVER stop mid-string, mid-array, or mid-object. Always close every open bracket before ending.`;
}

/**
 * User prompt with full context for checklist generation.
 */
export function generateChecklistUserPrompt(params: ChecklistGenerationParams): string {
  if (params.jurisdictionContext) {
    const jurisdictionName = params.jurisdictionContext.mode === 'SINGLE'
      ? jurisdictionLabel(params.jurisdictionContext.primaryJurisdiction)
      : params.jurisdictionContext.jurisdictions.map(jurisdictionLabel).join(', ');
    const jurisdictionCodes = params.jurisdictionContext.jurisdictions.join(', ');
    const ragSection = params.ragContext
      ? `\n\n## RETRIEVED REGULATORY CONTEXT\nThe following passages were retrieved from the SheriaBot regulatory corpus for ${jurisdictionName} (${jurisdictionCodes}) and accepted for checklist generation. Ground legal checklist items exclusively in this evidence:\n\n${params.ragContext}\n`
      : `\n\n## SOURCE INSUFFICIENCY\nNo retrieved regulatory source context was provided. Do not generate legal obligations, penalties, deadlines, statutory thresholds, filing requirements, or compliance conclusions. Provide only non-legal source-selection next steps.\n`;

    return `Generate a professional compliance checklist for the following financial-services business.

## AUTHORIZED JURISDICTION
${jurisdictionName} (${jurisdictionCodes})

## BUSINESS PROFILE
- **Product / Service Type:** ${params.productType}
- **Business Stage:** ${params.businessStage}
- **Target Customer Segments:** ${params.targetSegments.join(', ')}
- **Services Offered:** ${params.servicesOffered.join(', ')}
${params.additionalConcerns ? `- **Specific Compliance Concerns:** ${params.additionalConcerns}` : '- **Specific Compliance Concerns:** None provided'}
${ragSection}

## REQUIRED COVERAGE
Cover 3 to 4 core categories grounded in the retrieved evidence (e.g., Licensing & Authorisation, AML/CFT & Reporting, Data & Consumer Protection, Operational Controls), generating 3 to 4 concise items per category (10 to 14 total items). Keep descriptions and action items succinct and direct.

## REQUIRED JSON STRUCTURE
Return exactly this structure:
{
  "categories": [
    {
      "id": "LIC",
      "name": "Licensing & Registration",
      "description": "Core licensing and registration requirements supported by retrieved evidence.",
      "items": [
        {
          "id": "LIC-001",
          "title": "Specific action title",
          "regulatoryBasis": "Source document and section/clause from retrieved evidence",
          "priority": "CRITICAL",
          "description": "What must be done and why it matters.",
          "guidance": "Short implementation guidance.",
          "actionItems": ["Concrete step the team can perform"],
          "deadline": "Evidence-supported deadline or ongoing obligation",
          "penalty": "Evidence-supported penalty, or 'Not specified in retrieved evidence'"
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
}`;
  }

  const ragSection = params.ragContext
    ? `\n\n## RETRIEVED REGULATORY CONTEXT\nThe following passages were retrieved from a database of actual Kenyan regulatory documents. Use these to ground your checklist items in real law  -  cite the source document and section where applicable:\n\n${params.ragContext}\n`
    : `\n\n## SOURCE INSUFFICIENCY\nNo retrieved regulatory source context was provided. Do not generate legal obligations, penalties, deadlines, statutory thresholds, filing requirements, or compliance conclusions. State that verified regulatory source documents are required and provide only non-legal operational next steps.\n`;

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

1. **Licensing & Registration**  -  CBK licence/authorisation, sector registrations, FRC registration, incorporation
2. **Data Protection & Privacy**  -  DPA 2019, ODPC registration, consent framework, data subject rights, cross-border transfer restrictions
3. **AML / KYC / CFT**  -  POCAMLA obligations, CDD/EDD procedures, PEP screening, transaction monitoring, STR/CTR filing with FRC
4. **Consumer Protection**  -  Fair dealing, disclosure requirements, cooling-off periods, complaints handling (CBK Consumer Protection Guidelines)
5. **Capital & Prudential Requirements**  -  Minimum capital thresholds, liquidity requirements, reserve fund obligations
6. **Technology & Cybersecurity**  -  CBK Cybersecurity Guidance Note 2023, incident response plan, penetration testing, ISO 27001
7. **Reporting & Record Keeping**  -  Regulatory returns to CBK/CMA/IRA, transaction records, retention periods (POCAMLA: 7 years)
8. **Corporate Governance**  -  Board composition, fit-and-proper criteria for directors/senior management, ownership disclosure
9. **Outsourcing & Third-Party Risk**  -  CBK outsourcing policy, vendor due diligence, contractual requirements for subprocessors
10. **Business Continuity & Disaster Recovery**  -  BCP documentation, RPO/RTO targets, annual BCP testing
11. **Complaints Handling & Dispute Resolution**  -  Internal complaints procedure, CBK escalation pathway, turnaround time obligations
12. **Tax Compliance**  -  Digital Services Tax (1.5% of gross transaction value for non-residents), VAT registration, withholding tax, KRA PIN registration
13. **Foreign Exchange & Remittance**  -  (INCLUDE ONLY if FX, remittance, or cross-border services are offered) CBK forex dealer authorisation, SWIFT membership, cross-border reporting

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
          "guidance": "As a payment gateway targeting SME merchants, PSP authorisation is your single biggest regulatory blocker. CBK processing times average 90-120 days  -  begin this application before any commercial launch activity.",
          "actionItems": [
            "Download and complete CBK PSP application form from www.centralbank.go.ke/national-payments-system",
            "Prepare mandatory annexures: certificate of incorporation, memorandum and articles of association, audited financial statements (last 2 years or projections for new entities), IT system security documentation, AML/CFT policy, business continuity plan",
            "Pay non-refundable application fee of KES 10,000 via CBK payment portal",
            "Submit application package to Director, National Payments System, CBK, Haile Selassie Avenue, Nairobi",
            "Respond promptly to any CBK requests for additional information during the review period (typically 60-90 days)"
          ],
          "deadline": "Before commencing any payment service operations",
          "penalty": "Fine not exceeding KES 10,000,000 and/or imprisonment not exceeding 5 years  -  National Payment System Act 2011, Section 36"
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

## QUALITY REQUIREMENTS  -  NON-NEGOTIABLE
- **Minimum 25 items total** across at least 5 categories. Aim for 30-40 for complex products.
- **Minimum 3 items per included category.** No stub categories with 1-2 items.
- **Every item MUST have:**
  - \`regulatoryBasis\`: specific act name + section number (not just "various regulations")
  - \`description\`: 2-3 sentences explaining the obligation and its regulatory context
  - \`actionItems\`: 3-5 concrete, executable steps  -  name specific forms, portals, fees, or documents
  - \`deadline\`: tied to a specific regulatory event or calendar date
  - \`penalty\`: actual penalty from Kenyan law in KES; include imprisonment if applicable
- **Priority must be defensible**  -  CRITICAL means operations are illegal without it; HIGH means enforcement risk within 3 months
- **Priority distribution:** At least 4 CRITICAL, at least 6 HIGH items across the checklist
- **Guidance field:** Add only where this specific business profile (product type, stage, segments) creates a materially different compliance picture  -  not for generic items every fintech must do
- **Accuracy over brevity:** Do not invent section numbers. If you know the law but not the exact section, write "Section [confirm with legal counsel]" rather than fabricating a reference
- **Estimating \`estimatedCompletionDays\`:** Pre-launch / regulatory sandbox stage: 150-180 days (licensing queues); operational < 1 year: 90-120 days; established: 60-90 days

After generating all categories and items, count them accurately and populate:
- \`metadata.totalItems\` = exact count of all items across all categories
- \`metadata.criticalItems\` = exact count of items with priority "CRITICAL"
- \`metadata.highItems\` = exact count of items with priority "HIGH"

PRE-SUBMISSION SELF-CHECK  -  complete this before responding:
1. Does your response start with \`{\` and end with \`}\`? If not, something is wrong.
2. Is every \`[\` matched by a \`]\`? Is every \`{\` matched by a \`}\`?
3. Is every string value closed with a \`"\`? No trailing commas before \`}\` or \`]\`?
4. Does the root object contain both \`"categories"\` and \`"metadata"\` keys?
If any check fails, repair before responding.

Return ONLY valid JSON. Start with { and end with }. No other text before or after.`;
}

/**
 * Parse and strictly validate AI checklist output via Zod.
 *
 * Pipeline:
 *  1. Strip markdown code fences (Claude sometimes adds them despite instructions).
 *  2. JSON.parse()  -  throw if not valid JSON.
 *  3. GeneratedChecklistSchema.parse()  -  throw ZodError with field-level detail
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

  // JSON parse  -  attempt a fallback extraction if the model added leading text
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

  // Strict Zod validation  -  throws ZodError with field paths on schema mismatch
  const result = GeneratedChecklistSchema.safeParse(rawParsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`AI response failed schema validation: ${issues}`);
  }

  const parsed = result.data;

  // Recompute metadata counts from actual items  -  never trust the AI's self-reported counts.
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
  const MIN_ITEMS = 20; // Soft floor  -  Zod enforces 5 categories; this catches thin responses
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

// --- Three-Tier Generation Infrastructure ------------------------------------
//
// These exports are used by the tier-based generation pipeline in
// checklist.service.ts.  They are entirely additive  -  the legacy
// parseChecklistOutput() and generateChecklist*Prompt() functions above
// remain untouched for backward compatibility with complianceModule.

// -- Passage types -------------------------------------------------------------

/**
 * Minimal passage shape expected by the tier prompt builders.
 * SearchResult from rag.service.ts is a structural superset of this interface
 * and can be passed without any conversion.
 */
export interface RagPassage {
  chunkText: string;
  documentTitle: string;
}

// -- Token-budget RAG trimmer ---------------------------------------------------

/**
 * Trim a list of RAG passages to fit within a rough token budget.
 * Uses the standard approximation: 1 token ≈ 4 characters.
 * Passages are included in order (highest-relevance first) until the budget
 * is exhausted; the first passage is always included even if it alone exceeds
 * the budget.
 */
export function trimRagPassages(
  passages: RagPassage[],
  maxTokenBudget: number
): RagPassage[] {
  let currentTokens = 0;
  const trimmed: RagPassage[] = [];

  for (const passage of passages) {
    const estimatedTokens = Math.ceil(passage.chunkText.length / 4);
    if (trimmed.length > 0 && currentTokens + estimatedTokens > maxTokenBudget) break;
    trimmed.push(passage);
    currentTokens += estimatedTokens;
  }

  return trimmed;
}

// -- Internal context builder ---------------------------------------------------

function buildRagContextString(passages: RagPassage[]): string {
  return passages
    .map(
      (r, i) =>
        `[REGULATORY CONTEXT ${i + 1}  -  ${r.documentTitle || 'Regulatory source'}]\n${r.chunkText}`
    )
    .join('\n\n---\n\n');
}

// -- Tier-specific Zod schemas -------------------------------------------------
//
// Each tier relaxes both the minimum category count and the minimum item count.
// Partial validation (category-by-category) is handled in parseWithTierSchema()
// so these schemas are applied to the FULL categories array first and the per-
// category fallback is only attempted when the full-schema validation fails.

export const Tier1ResponseSchema = z.object({
  categories: z.array(ChecklistCategorySchema).min(4, 'Tier 1 requires at least 4 categories'),
  metadata:   GeneratedChecklistSchema.shape.metadata,
}).refine(
  (d) => d.categories.flatMap((c) => c.items).length >= 25,
  { message: 'Tier 1 requires at least 25 items total' }
);

export const Tier2ResponseSchema = z.object({
  categories: z.array(ChecklistCategorySchema).min(3, 'Tier 2 requires at least 3 categories'),
  metadata:   GeneratedChecklistSchema.shape.metadata,
}).refine(
  (d) => d.categories.flatMap((c) => c.items).length >= 10,
  { message: 'Tier 2 requires at least 10 items total' }
);

// Tier 3 metadata is fully optional  -  we synthesize any missing fields from
// the validated categories and the original generation input.
export const Tier3ResponseSchema = z.object({
  categories: z.array(ChecklistCategorySchema).min(2, 'Tier 3 requires at least 2 categories'),
  metadata: z.object({
    productType:             z.string().optional(),
    businessStage:           z.string().optional(),
    totalItems:              z.number().int().min(0).optional(),
    criticalItems:           z.number().int().min(0).optional(),
    highItems:               z.number().int().min(0).optional(),
    estimatedCompletionDays: z.number().int().positive().optional(),
    generatedAt:             z.string().optional(),
    ragSourcesUsed:          z.number().int().min(0).optional(),
  }).optional(),
}).refine(
  (d) => d.categories.flatMap((c) => c.items).length >= 5,
  { message: 'Tier 3 requires at least 5 items total' }
);

// -- Tier-specific system prompts -----------------------------------------------

function generateTier2SystemPrompt(): string {
  return `You are SheriaBot, a senior regulatory compliance advisor for Kenya's fintech sector. You specialize in:
- Data Protection Act 2019 (DPA)  -  ODPC registration, consent frameworks, data subject rights
- National Payment System Act 2011 (NPSA)  -  CBK PSP authorisation and payment regulations
- POCAMLA  -  AML/CFT obligations, FRC registration, CDD/EDD, STR/CTR filing
- Digital Credit Providers Regulations 2022  -  licensing for digital lenders
- CBK Act (Cap 491)  -  prudential requirements, capital thresholds
- Computer Misuse and Cybercrimes Act 2018  -  cybersecurity obligations
- Consumer Protection Act 2012  -  fair dealing, disclosure, complaints handling
- Capital Markets Act (Cap 485A) and CMA Crowdfunding Regulations 2022
- CBK Guidance Note on Cybersecurity (March 2023)

REGULATORS: Central Bank of Kenya (CBK), ODPC, Financial Reporting Centre (FRC), CMA, IRA, KRA, SASRA

OUTPUT RULES  -  FOLLOW EXACTLY:
1. Respond ONLY with valid JSON. No markdown fences, no preamble. Start with { and end with }.
2. Every item MUST cite a specific Kenyan law with the section number.
3. Penalties MUST include specific KES amounts where defined in legislation.
4. Action items must be specific and actionable  -  name forms, portals, fees, and documents.
5. Deadlines must be tied to a regulatory event, not vague.
6. Generate 15-20 focused checklist items across 3-5 categories. Prioritise the most critical requirements.
7. Keep response concise  -  descriptions under 200 characters, action items under 150 characters each.
8. Priority distribution: at least 3 CRITICAL, at least 4 HIGH items.

ANTI-TRUNCATION PROTOCOL  -  FOLLOW IF APPROACHING TOKEN LIMIT:
If you are near your response limit before finishing all categories:
  a) Finish the current item completely (close all strings and the item object: }).
  b) Close the current items array: ]
  c) Close the current category object: }
  d) Close the categories array: ]
  e) Emit a valid metadata block and close the root object: }
A valid 3-category response is more useful than a broken 6-category response.
NEVER stop mid-string or mid-object.`;
}

function generateTier3SystemPrompt(): string {
  return `You are a Kenyan fintech regulatory compliance advisor. No retrieved regulatory source context is available.

Do not generate legal obligations, legal citations, penalties, statutory thresholds, regulator filing requirements, legal deadlines, or compliance conclusions.
Return a source-insufficiency checklist that asks the user to add or select verified regulatory source documents and provides only non-legal operational next steps.

OUTPUT RULES  -  FOLLOW EXACTLY:
1. Respond ONLY with valid JSON. No markdown fences, no preamble. Start with { and end with }.
2. Do not cite laws, sections, penalties, deadlines, or obligations.
3. Generate 3-5 non-legal operational items about selecting, uploading, or narrowing source documents.
4. Keep all string values under 300 characters.
5. Metadata fields are optional  -  omit any you are unsure about.

ANTI-TRUNCATION PROTOCOL  -  FOLLOW IF APPROACHING TOKEN LIMIT:
If you are running out of space: finish the current item, close items array ], close category }, close categories array ], emit metadata {}, close root }.
NEVER stop mid-string. A small valid JSON beats a large broken one.`;
}

// -- Tier-specific user prompts -------------------------------------------------

function generateTier2UserPrompt(params: ChecklistGenerationParams): string {
  if (params.jurisdictionContext) {
    return generateChecklistUserPrompt(params);
  }

  const ragSection = params.ragContext
    ? `\n\n## RETRIEVED REGULATORY CONTEXT (use to cite specific laws)\n${params.ragContext}\n`
    : `\n\n## SOURCE INSUFFICIENCY\nNo retrieved regulatory source context is available. Do not generate legal obligations, legal citations, penalties, statutory thresholds, filing requirements, legal deadlines, or compliance conclusions. Return only non-legal operational next steps for adding or selecting verified regulatory sources.\n`;

  return `Generate a focused compliance checklist for this Kenyan fintech business. Generate 15-20 items across 3-5 categories  -  prioritise the most critical regulatory requirements.

## BUSINESS PROFILE
- **Product / Service Type:** ${params.productType}
- **Business Stage:** ${params.businessStage}
- **Target Segments:** ${params.targetSegments.join(', ')}
- **Services Offered:** ${params.servicesOffered.join(', ')}
${params.additionalConcerns ? `- **Specific Concerns:** ${params.additionalConcerns}` : ''}
${ragSection}

## REQUIRED JSON STRUCTURE
{
  "categories": [
    {
      "id": "LIC",
      "name": "Licensing & Registration",
      "description": "Core licensing requirements.",
      "items": [
        {
          "id": "LIC-001",
          "title": "Obtain CBK PSP Authorisation",
          "regulatoryBasis": "National Payment System Act 2011, Section 12",
          "priority": "CRITICAL",
          "description": "All payment service providers must obtain CBK authorisation before commencing operations.",
          "actionItems": ["Download CBK PSP application form", "Submit to CBK Director, National Payments"],
          "deadline": "Before commencing operations",
          "penalty": "Fine not exceeding KES 10,000,000  -  National Payment System Act 2011, Section 36"
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
    "ragSourcesUsed": ${params.ragSourcesUsed ?? 0}
  }
}

PRE-SUBMISSION SELF-CHECK: Does your response start with \`{\` and end with \`}\`? Is every \`[\` closed with \`]\`? Is every string properly quoted? Repair any issues before responding.

Return ONLY valid JSON. Start with { and end with }. No other text.`;
}

function generateTier3UserPrompt(params: Pick<ChecklistGenerationParams, 'productType' | 'businessStage' | 'targetSegments' | 'servicesOffered' | 'additionalConcerns' | 'jurisdictionContext'>): string {
  if (params.jurisdictionContext) {
    const jurisdictionName = params.jurisdictionContext.mode === 'SINGLE'
      ? jurisdictionLabel(params.jurisdictionContext.primaryJurisdiction)
      : params.jurisdictionContext.jurisdictions.map(jurisdictionLabel).join(', ');
    return `No retrieved regulatory source context is available for this ${jurisdictionName} checklist request. Do not generate legal obligations, legal citations, penalties, statutory thresholds, filing requirements, legal deadlines, or compliance conclusions. Generate 3-5 non-legal operational checklist items that help the user add or select verified regulatory sources.

## BUSINESS PROFILE
- **Product / Service Type:** ${params.productType}
- **Business Stage:** ${params.businessStage}
- **Services Offered:** ${params.servicesOffered.join(', ')}
${params.additionalConcerns ? `- **Specific Concerns:** ${params.additionalConcerns}` : ''}

Return ONLY valid JSON. Start with { and end with }. No other text.`;
  }

  return `No retrieved regulatory source context is available for this Kenyan fintech checklist request. Do not generate legal obligations, legal citations, penalties, statutory thresholds, filing requirements, legal deadlines, or compliance conclusions. Generate 3-5 non-legal operational checklist items that help the user add or select verified regulatory sources.

## BUSINESS PROFILE
- **Product / Service Type:** ${params.productType}
- **Business Stage:** ${params.businessStage}
- **Services Offered:** ${params.servicesOffered.join(', ')}
${params.additionalConcerns ? `- **Specific Concerns:** ${params.additionalConcerns}` : ''}

## REQUIRED JSON STRUCTURE
{
  "categories": [
    {
      "id": "LIC",
      "name": "Source Preparation",
      "description": "Non-legal steps needed before a source-grounded assessment.",
      "items": [
        {
          "id": "LIC-001",
          "title": "Select relevant regulatory sources",
          "regulatoryBasis": "Source required before legal assessment",
          "priority": "CRITICAL",
          "description": "Choose the Act, Regulation, Guideline, Circular, or benchmark document that should ground this checklist.",
          "actionItems": ["Select source documents", "Re-run checklist generation with verified sources"],
          "deadline": "Source required before legal assessment",
          "penalty": "No penalty assessed without source evidence"
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
    "ragSourcesUsed": 0
  }
}

PRE-SUBMISSION SELF-CHECK: Does your response start with \`{\` and end with \`}\`? Is every \`[\` closed? Every string quoted? Fix before responding.

Return ONLY valid JSON. Start with { and end with }. No other text.`;
}

// -- Tier prompt builders (public API for checklist.service.ts) -----------------

export function buildTier1Prompt(
  input: Pick<ChecklistGenerationParams, 'productType' | 'businessStage' | 'targetSegments' | 'servicesOffered' | 'additionalConcerns' | 'jurisdictionContext'>,
  passages: RagPassage[]
): { system: string; user: string } {
  const trimmed = trimRagPassages(passages, 8000);
  const ragContext = trimmed.length > 0 ? buildRagContextString(trimmed) : undefined;
  return {
    system: generateChecklistSystemPrompt(input.jurisdictionContext),
    user: generateChecklistUserPrompt({
      productType:        input.productType,
      businessStage:      input.businessStage,
      targetSegments:     input.targetSegments,
      servicesOffered:    input.servicesOffered,
      additionalConcerns: input.additionalConcerns,
      ragContext,
      ragSourcesUsed: trimmed.length,
      jurisdictionContext: input.jurisdictionContext,
    }),
  };
}

export function buildTier2Prompt(
  input: Pick<ChecklistGenerationParams, 'productType' | 'businessStage' | 'targetSegments' | 'servicesOffered' | 'additionalConcerns' | 'jurisdictionContext'>,
  passages: RagPassage[]
): { system: string; user: string } {
  const trimmed = trimRagPassages(passages, 3000);
  const ragContext = trimmed.length > 0 ? buildRagContextString(trimmed) : undefined;
  return {
    system: input.jurisdictionContext ? generateChecklistSystemPrompt(input.jurisdictionContext) : generateTier2SystemPrompt(),
    user: generateTier2UserPrompt({
      productType:        input.productType,
      businessStage:      input.businessStage,
      targetSegments:     input.targetSegments,
      servicesOffered:    input.servicesOffered,
      additionalConcerns: input.additionalConcerns,
      ragContext,
      ragSourcesUsed: trimmed.length,
      jurisdictionContext: input.jurisdictionContext,
    }),
  };
}

export function buildTier3Prompt(
  input: Pick<ChecklistGenerationParams, 'productType' | 'businessStage' | 'targetSegments' | 'servicesOffered' | 'additionalConcerns' | 'jurisdictionContext'>
): { system: string; user: string } {
  return {
    system: input.jurisdictionContext ? generateChecklistSystemPrompt(input.jurisdictionContext) : generateTier3SystemPrompt(),
    user: generateTier3UserPrompt(input),
  };
}

// -- Unified metadata synthesiser -----------------------------------------------

function synthesizeMetadata(
  rawMetadata: Record<string, unknown> | null | undefined,
  validCategories: ChecklistCategory[],
  input: { productType: string; businessStage: string },
  ragSourcesUsed: number,
  options?: {
    truncated?: boolean;
    expectedCategories?: number;
    completedCategories?: number;
  }
): GeneratedChecklist['metadata'] {
  let totalItems = 0;
  let criticalItems = 0;
  let highItems = 0;

  for (const cat of validCategories) {
    totalItems += cat.items.length;
    for (const item of cat.items) {
      if (item.priority === 'CRITICAL') criticalItems++;
      if (item.priority === 'HIGH') highItems++;
    }
  }

  const truncated = options?.truncated ?? (rawMetadata?.truncated === true);
  const completedCategories = options?.completedCategories ?? validCategories.length;
  const expectedCategories = options?.expectedCategories ?? ((rawMetadata?.expectedCategories as number | undefined) ?? completedCategories);
  const isPartial = truncated || completedCategories < expectedCategories;
  const generationStatus: 'COMPLETE' | 'PARTIAL' | 'FAILED' = isPartial ? 'PARTIAL' : 'COMPLETE';
  const generationComplete = !isPartial;

  return {
    productType:             (rawMetadata?.productType  as string | undefined) ?? input.productType,
    businessStage:           (rawMetadata?.businessStage as string | undefined) ?? input.businessStage,
    totalItems,
    criticalItems,
    highItems,
    estimatedCompletionDays: (rawMetadata?.estimatedCompletionDays as number | undefined) ?? 90,
    generatedAt:             new Date().toISOString(),
    ragSourcesUsed:          (rawMetadata?.ragSourcesUsed as number | undefined) ?? ragSourcesUsed,
    generationStatus,
    generationComplete,
    expectedCategories,
    completedCategories,
    truncated,
  };
}

/**
 * Deterministically deduplicate checklist items across/within categories.
 * Identifies duplicate obligations based on normalized title & legalBasis.
 */
export function deduplicateChecklistCategories(categories: ChecklistCategory[]): {
  categories: ChecklistCategory[];
  duplicatesRemoved: number;
  duplicateLog: Array<{ originalTitle: string; duplicateTitle: string; category: string }>;
} {
  const seenSignatures = new Set<string>();
  const duplicateLog: Array<{ originalTitle: string; duplicateTitle: string; category: string }> = [];
  let duplicatesRemoved = 0;

  const deduplicatedCategories: ChecklistCategory[] = categories.map((cat) => {
    const uniqueItems: ChecklistItem[] = [];
    for (const item of cat.items) {
      const normalizedTitle = item.title.toLowerCase().replace(/[^a-z0-9]/g, '');
      const normalizedBasis = (item.regulatoryBasis ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const signature = `${normalizedTitle}::${normalizedBasis}`;

      if (seenSignatures.has(signature)) {
        duplicatesRemoved++;
        duplicateLog.push({
          originalTitle: item.title,
          duplicateTitle: item.title,
          category: cat.name,
        });
      } else {
        seenSignatures.add(signature);
        uniqueItems.push(item);
      }
    }
    return { ...cat, items: uniqueItems };
  });

  return {
    categories: deduplicatedCategories,
    duplicatesRemoved,
    duplicateLog,
  };
}

// -- JSON extraction helper -----------------------------------------------------

/**
 * Extract a parseable JSON object from raw AI output.
 *
 * Steps:
 *  1. Strip markdown code fences.
 *  2. Try direct JSON.parse().
 *  3. If that fails, try extracting the outermost {...} block and parsing it.
 *  4. If that fails, attempt brace/bracket balancing to repair truncated JSON,
 *     then parse.  (Needed when the response was cut off mid-output.)
 *
 * Returns the parsed value or throws with a descriptive message.
 */
function extractJsonObject(rawContent: string, checklistId?: string): unknown {
  let content = rawContent.trim();

  // Step 1  -  strip markdown code fences
  if (content.startsWith('```')) {
    content = content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
  }

  // Step 2  -  direct parse
  try {
    return JSON.parse(content);
  } catch { /* fall through */ }

  // Step 3  -  extract outermost {...} block
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('AI response contains no JSON object');
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch { /* fall through to repair */ }

  // Step 4  -  brace/bracket balancing for truncated responses
  let candidate = jsonMatch[0].trim();

  // If truncated mid-string/mid-item, slice back to last complete object closing brace '}'
  const lastCompleteObject = candidate.lastIndexOf('}');
  if (lastCompleteObject > 0) {
    candidate = candidate.slice(0, lastCompleteObject + 1);
  }

  let braces = 0;
  let brackets = 0;
  for (const char of candidate) {
    if      (char === '{') braces++;
    else if (char === '}') braces--;
    else if (char === '[') brackets++;
    else if (char === ']') brackets--;
  }

  let repaired = candidate.trim().replace(/,\s*$/, '');
  while (brackets > 0) { repaired += ']'; brackets--; }
  while (braces   > 0) { repaired += '}'; braces--;   }

  try {
    const parsed = JSON.parse(repaired);
    logger.info({
      type:            'checklist_json_repaired',
      checklistId,
      originalLength:  rawContent.length,
      repairedLength:  repaired.length,
    });
    return parsed;
  } catch (repairErr: unknown) {
    logger.warn({
      type:        'checklist_json_repair_failed',
      checklistId,
      contentTail: rawContent.slice(-300),
      error:       repairErr instanceof Error ? repairErr.message : String(repairErr),
    });
    throw new Error(
      `AI response contains malformed JSON that could not be repaired: ${repairErr instanceof Error ? repairErr.message : String(repairErr)}`
    );
  }
}

// -- Partial category recovery --------------------------------------------------

/**
 * Attempt to recover valid categories from an object that failed full-schema
 * validation.  Each category in rawData.categories is validated individually
 * with ChecklistCategorySchema.  Only Zod-valid categories are accepted.
 *
 * Returns the set of valid categories, or throws if not enough are recovered
 * to meet the tier minimums.
 */
function attemptPartialCategoryRecovery(
  rawData: Record<string, unknown>,
  tier: 1 | 2 | 3,
  checklistId: string | undefined
): ChecklistCategory[] {
  const tierMinCats  = tier === 1 ? 3 : tier === 2 ? 2 : 1;
  const tierMinItems = tier === 1 ? 8 : tier === 2 ? 5 : 3;

  if (!Array.isArray(rawData.categories)) {
    throw new Error(`Tier ${tier}: AI response missing 'categories' array`);
  }

  const validCategories: ChecklistCategory[] = [];
  const invalidIndices: number[] = [];

  for (let i = 0; i < (rawData.categories as unknown[]).length; i++) {
    const result = ChecklistCategorySchema.safeParse((rawData.categories as unknown[])[i]);
    if (result.success) {
      validCategories.push(result.data);
    } else {
      invalidIndices.push(i);
    }
  }

  const totalItems      = validCategories.reduce((s, c) => s + c.items.length, 0);
  const totalCategories = (rawData.categories as unknown[]).length;

  const hasEnoughCats  = validCategories.length >= tierMinCats;
  const hasEnoughItems = totalItems >= tierMinItems;
  const passesRatio    = validCategories.length >= totalCategories * 0.6;

  if (hasEnoughCats && hasEnoughItems && (invalidIndices.length === 0 || passesRatio)) {
    if (invalidIndices.length > 0) {
      logger.warn({
        type:           'checklist_partial_recovery',
        checklistId,
        tier,
        totalCategories,
        validCategories: validCategories.length,
        invalidIndices,
        totalItems,
      });
    }
    return validCategories;
  }

  throw new Error(
    `Tier ${tier} partial recovery: only ${validCategories.length}/${totalCategories} categories valid ` +
    `(${totalItems} items). Need ≥${tierMinCats} valid categories, ≥${tierMinItems} items, ` +
    `≥60% validity ratio.`
  );
}

// -- Main tier parse function ---------------------------------------------------

/**
 * Parse and validate raw AI output for a given generation tier.
 *
 * Pipeline:
 *  1. extractJsonObject()  -  strip fences, JSON.parse, repair truncation
 *  2. Attempt full tier Zod schema validation (strictest pass)
 *  3. If full validation fails, attempt per-category Zod recovery
 *  4. synthesizeMetadata()  -  recompute counts from validated data; fill defaults
 *  5. Return a complete GeneratedChecklist
 *
 * Throws on unrecoverable failure so callers can escalate to the next tier.
 * No unvalidated data reaches the database  -  every category in the result has
 * passed ChecklistCategorySchema.safeParse().
 */
export function parseWithTierSchema(
  rawContent: string,
  tier: 1 | 2 | 3,
  logCtx: {
    checklistId?: string;
    input: { productType: string; businessStage: string };
    ragSourcesUsed?: number;
  }
): GeneratedChecklist {
  const { checklistId, input, ragSourcesUsed = 0 } = logCtx;

  // Step 1  -  get a parseable object
  const rawParsed = extractJsonObject(rawContent, checklistId);

  if (!rawParsed || typeof rawParsed !== 'object' || Array.isArray(rawParsed)) {
    throw new Error(`Tier ${tier}: AI response is not a JSON object`);
  }

  const rawData = rawParsed as Record<string, unknown>;

  // Step 2  -  try full tier schema
  const tierSchema =
    tier === 1 ? Tier1ResponseSchema :
    tier === 2 ? Tier2ResponseSchema :
                 Tier3ResponseSchema;

  const fullResult = tierSchema.safeParse(rawData);

  let validCategories: ChecklistCategory[];
  let isPartialRecovery = false;

  if (fullResult.success) {
    validCategories = fullResult.data.categories;
  } else {
    // Step 3  -  per-category recovery (throws if insufficient)
    logger.warn({
      type:        'checklist_tier_full_schema_failed',
      checklistId,
      tier,
      issues:      fullResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
    validCategories = attemptPartialCategoryRecovery(rawData, tier, checklistId);
    isPartialRecovery = true;
  }

  const rawCategoriesCount = Array.isArray(rawData.categories) ? rawData.categories.length : validCategories.length;
  const rawExpectedCats = (rawData.metadata as Record<string, unknown> | undefined)?.expectedCategories as number | undefined;

  // Step 4  -  synthesize complete metadata (always recomputes counts)
  const metadata = synthesizeMetadata(
    rawData.metadata as Record<string, unknown> | null | undefined,
    validCategories,
    input,
    ragSourcesUsed,
    {
      truncated: isPartialRecovery || (rawData.metadata as Record<string, unknown> | undefined)?.truncated === true,
      expectedCategories: rawExpectedCats ?? Math.max(rawCategoriesCount, validCategories.length),
      completedCategories: validCategories.length,
    }
  );

  return { categories: validCategories, metadata };
}
