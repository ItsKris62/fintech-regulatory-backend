/**
 * Gap Analysis Generation Prompts
 * AI prompts for comparing uploaded policy documents against
 * Kenyan regulatory requirements using RAG-retrieved context.
 */

import { z } from 'zod';

// --- Input Types -------------------------------------------------------------

export interface GapAnalysisParams {
  policyText: string;
  documentName: string;
  documentType: string;
  regulatoryFrameworks: string[];
  analysisDepth: 'quick' | 'standard' | 'deep';
  focusAreas?: string[];
  ragContext?: string; // Retrieved regulatory passages from Pinecone
}

// --- Zod Validation Schemas + Inferred Types ---------------------------------
//
// These are the canonical output types for gap analysis.  All types are derived
// directly from their Zod schemas so the runtime validator and TypeScript type
// are always in sync.

export const GapItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
  regulatoryBasis: z.string(),
  description: z.string(),
  policyCurrentState: z.string(),
  recommendation: z.string(),
  effort: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  priority: z.number().int().min(1),
  /** Documents/artefacts that must be produced to close this gap. */
  evidenceRequired: z.array(z.string()).default([]),
  /** Role accountable for resolving this gap. */
  responsibleRole: z.string().optional(),
  /** Regulatory deadline if the regulation specifies one. */
  regulatoryDeadline: z.string().optional(),
  /** Post-hoc verification: true if regulatoryBasis was found in the legal corpus. */
  citationVerified: z.boolean().optional(),
  verificationStatus: z.enum(['verified', 'unverified', 'not_checked']).optional(),
  sourceDocumentTitle: z.string().optional(),
  sourceSection: z.string().optional(),
  sourceSnippet: z.string().optional(),
  authorityStatus: z.string().optional(),
  isBinding: z.boolean().optional(),
});

export const FrameworkResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  score: z.number().min(0).max(100),
  gaps: z.array(GapItemSchema),
  strengths: z.array(z.string()),
  summary: z.string(),
});

export const ActionPlanItemSchema = z.object({
  priority: z.number().int().min(1),
  action: z.string(),
  framework: z.string(),
  deadline: z.string(),
  effort: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  resources: z.array(z.string()),
  dependsOn: z.array(z.string()).default([]),
  /** Role accountable for delivering this action. */
  responsibleRole: z.string().optional(),
});

export const GapAnalysisResultSchema = z.object({
  overallScore: z.number().min(0).max(100),
  executiveSummary: z.string(),
  frameworks: z.array(FrameworkResultSchema).min(1),
  crossCuttingStrengths: z.array(z.string()),
  actionPlan: z.array(ActionPlanItemSchema),
  metadata: z.object({
    documentName: z.string(),
    analysisDepth: z.string(),
    frameworksAnalysed: z.array(z.string()),
    totalGaps: z.number().int().min(0),
    criticalGaps: z.number().int().min(0),
    highGaps: z.number().int().min(0),
    mediumGaps: z.number().int().min(0).optional(),
    lowGaps: z.number().int().min(0).optional(),
    analysisDate: z.string(),
    chunksProcessed: z.number().int().positive().optional(),
    tokenCost: z.object({
      inputTokens: z.number().int().min(0),
      outputTokens: z.number().int().min(0),
      estimatedCostUsd: z.number().min(0),
    }).optional(),
  }),
});

/**
 * Raw gap item returned by the per-chunk phase.
 * Identical to GapItemSchema but includes a `framework` identifier so the
 * merge pass can group gaps by framework.
 */
export const RawChunkGapItemSchema = GapItemSchema.extend({
  framework: z.string(),
});

/** Zod schema for the full JSON array a single chunk analysis returns. */
export const ChunkOutputSchema = z.array(RawChunkGapItemSchema);

// Inferred types  -  use these throughout the codebase instead of manual interfaces.
export type GapItem = z.infer<typeof GapItemSchema>;
export type FrameworkResult = z.infer<typeof FrameworkResultSchema>;
export type ActionPlanItem = z.infer<typeof ActionPlanItemSchema>;
export type GapAnalysisResult = z.infer<typeof GapAnalysisResultSchema>;
export type RawChunkGapItem = z.infer<typeof RawChunkGapItemSchema>;
export type ChunkOutput = z.infer<typeof ChunkOutputSchema>;

// --- Chunking Strategy (T1) -------------------------------------------------

export interface PolicyChunk {
  index: number;
  total: number;
  text: string;
  charStart: number;
  charEnd: number;
}

/**
 * Chunk size and overlap constants.
 * A chunk of ~6,000 characters fits comfortably within Claude's context
 * alongside the system prompt, RAG context, and JSON response buffer.
 */
export const CHUNK_SIZE = 6000;
export const CHUNK_OVERLAP = 800;

/**
 * Split policy text into overlapping chunks that respect paragraph boundaries.
 * If the text fits within CHUNK_SIZE the result is a single-element array  - 
 * callers should check length === 1 to skip the multi-pass path.
 */
export function chunkPolicyText(
  text: string,
  chunkSize = CHUNK_SIZE,
  overlap = CHUNK_OVERLAP
): PolicyChunk[] {
  if (text.length <= chunkSize) {
    return [{ index: 0, total: 1, text, charStart: 0, charEnd: text.length }];
  }

  const paragraphs = text.split(/\n\n+/);
  const chunks: PolicyChunk[] = [];
  let current = '';
  let charStart = 0;
  let absolutePos = 0;

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;

    if (candidate.length <= chunkSize) {
      current = candidate;
    } else {
      if (current) {
        const charEnd = charStart + current.length;
        chunks.push({ index: chunks.length, total: 0, text: current, charStart, charEnd });
        // Overlap: carry the last `overlap` chars into the next chunk
        const tail = current.length > overlap ? current.slice(-overlap) : current;
        charStart = charEnd - tail.length;
        current = `${tail}\n\n${para}`;
      } else {
        // Single paragraph larger than chunkSize  -  split at nearest word boundary
        let pos = 0;
        while (pos < para.length) {
          let end = pos + chunkSize;
          if (end < para.length) {
            const ws = para.lastIndexOf(' ', end);
            if (ws > pos) end = ws;
          } else {
            end = para.length;
          }
          const slice = para.slice(pos, end);
          chunks.push({
            index: chunks.length,
            total: 0,
            text: slice,
            charStart: absolutePos + pos,
            charEnd: absolutePos + end,
          });
          pos = end - overlap;
          if (pos <= 0 || pos >= para.length) break;
        }
        current = '';
        charStart = absolutePos + para.length;
      }
    }
    absolutePos += para.length + 2; // +2 for the \n\n separator
  }

  if (current.trim()) {
    chunks.push({
      index: chunks.length,
      total: 0,
      text: current,
      charStart,
      charEnd: charStart + current.length,
    });
  }

  // Back-fill total count now that we know how many chunks there are
  const total = chunks.length;
  for (const c of chunks) c.total = total;
  return chunks;
}

// --- Prompt Injection Sanitization -------------------------------------------

/**
 * Patterns that are characteristic of prompt injection attacks embedded inside
 * a policy document.  Each pattern is replaced with '[REDACTED]' so the
 * surrounding text remains readable but the instruction cannot be executed.
 *
 * Returns the sanitized text and a flag indicating whether any substitution
 * was made (so callers can log the event).
 */
export function sanitizePolicyText(text: string): { sanitized: string; wasModified: boolean } {
  const patterns: RegExp[] = [
    /ignore\s+(all\s+)?previous\s+instructions?/gi,
    /ignore\s+(all\s+)?above\s+instructions?/gi,
    /disregard\s+(all\s+)?previous/gi,
    /instead[,\s]+output/gi,
    /new\s+instructions?\s*:/gi,
    /\bsystem\s*:\s*/gi,
    /\[SYSTEM\]/gi,
    /\[INST\]/gi,
    /<<SYS>>/gi,
    /<\|im_start\|>/gi,
    /forget\s+(everything|all)\s+(above|previous|prior)/gi,
    /you\s+are\s+now\s+a\s+different\s+(ai|assistant|model)/gi,
  ];

  let sanitized = text;
  let wasModified = false;

  for (const pattern of patterns) {
    if (pattern.test(sanitized)) {
      wasModified = true;
      sanitized = sanitized.replace(pattern, '[REDACTED]');
    }
  }

  return { sanitized, wasModified };
}

// --- Shared Schema Example ----------------------------------------------------

/**
 * Returns the required JSON schema example string embedded in prompts.
 * Shared between single-pass and merge prompts to keep them in sync.
 */
function buildRequiredJsonSchema(params: {
  documentName: string;
  analysisDepth: string;
  regulatoryFrameworks: string[];
}): string {
  return `{
  "overallScore": 65,
  "executiveSummary": "This policy demonstrates foundational compliance awareness but has significant gaps in data subject rights procedures (DPA 2019) and transaction monitoring thresholds (POCAMLA). Immediate action is required on 2 CRITICAL gaps before the policy can be considered regulatory-grade.",
  "frameworks": [
    {
      "id": "DPA_2019",
      "name": "Data Protection Act 2019",
      "score": 60,
      "summary": "The policy addresses basic data collection principles but lacks required procedures for data subject access requests, erasure, and breach notification.",
      "gaps": [
        {
          "id": "DPA-G001",
          "title": "No Data Subject Rights Procedure",
          "severity": "HIGH",
          "regulatoryBasis": "Data Protection Act 2019, Section 26  -  Right of access; Section 30  -  Right to erasure",
          "description": "The policy does not define procedures for handling data subject requests (access, rectification, erasure, objection). The DPA requires responses within 21 days.",
          "policyCurrentState": "Policy mentions 'we respect privacy' but contains no operational procedure for handling subject rights requests.",
          "recommendation": "Draft and implement a Data Subject Rights Procedure covering: request intake form, 21-day response SLA, escalation process, and rejection grounds as per DPA Section 26-32.",
          "effort": "MEDIUM",
          "priority": 1,
          "evidenceRequired": ["Data Subject Rights Request Form", "Procedure SOP document", "Staff training records on DPA rights"],
          "responsibleRole": "Data Protection Officer",
          "regulatoryDeadline": "Immediate  -  DPA 2019 is in force; non-compliance risks ODPC enforcement"
        }
      ],
      "strengths": [
        "Policy correctly identifies lawful bases for data processing (DPA 2019, Section 30)",
        "Privacy notice obligations are acknowledged with reference to customer communication"
      ]
    }
  ],
  "crossCuttingStrengths": [
    "Policy demonstrates senior management commitment to compliance through board sign-off",
    "Annual review cycle is established"
  ],
  "actionPlan": [
    {
      "priority": 1,
      "action": "Draft and implement a Data Subject Rights Procedure",
      "framework": "Data Protection Act 2019",
      "deadline": "Within 30 days",
      "effort": "MEDIUM",
      "resources": ["DPO or external data protection counsel", "DPA 2019 Sections 26-32", "ODPC guidance on subject rights"],
      "responsibleRole": "Data Protection Officer (DPO)",
      "dependsOn": []
    }
  ],
  "metadata": {
    "documentName": "${params.documentName}",
    "analysisDepth": "${params.analysisDepth}",
    "frameworksAnalysed": ${JSON.stringify(params.regulatoryFrameworks)},
    "totalGaps": 0,
    "criticalGaps": 0,
    "highGaps": 0,
    "analysisDate": "${new Date().toISOString()}"
  }
}`;
}

// --- Prompt Builders ---------------------------------------------------------

/**
 * System prompt for gap analysis (T4: expanded regulation list).
 */
export function generateGapAnalysisSystemPrompt(): string {
  return `You are a senior Kenyan financial regulatory compliance auditor with 15+ years of experience. You specialise in reviewing internal compliance policies and procedures against Kenyan regulatory requirements.

Your expertise covers:
- Data Protection Act 2019 (DPA) and ODPC General Regulations 2021
- CBK Prudential Guidelines and Banking Act (Cap 488)
- National Payment System Act 2011 and NPS Regulations 2014
- Proceeds of Crime and Anti-Money Laundering Act (POCAMLA) and AML/CFT Guidelines
- CBK Cybersecurity Guidance Note 2023 (CBS/PG/82)
- Consumer Protection Act 2012 and CBK consumer protection guidelines
- Capital Markets Authority (CMA) Act and CMA Regulations
- Digital Credit Providers Regulations 2022
- Computer Misuse and Cybercrimes Act 2018
- Kenya Information and Communications Act (KICA) and ICT regulations

Your task is to conduct a rigorous gap analysis of the provided policy document(s) against the specified regulatory frameworks. You must:
1. Identify specific gaps where the policy fails to meet regulatory requirements
2. Cite the exact Kenyan law section that creates each obligation
3. Rate severity accurately: CRITICAL = legal exposure/licence risk; HIGH = likely regulatory finding; MEDIUM = best-practice gap; LOW = minor improvement
4. For each gap, you MUST populate ALL of these fields: evidenceRequired (artefacts needed to close the gap), responsibleRole (accountable role/department), and regulatoryDeadline (statutory timeline or "Ongoing obligation")
5. Identify genuine strengths to give a balanced assessment
6. Calculate a realistic compliance score (0-100) per framework and overall

EXECUTIVE SUMMARY REQUIREMENTS:
The executiveSummary field must be written at a level suitable for presentation to a Board of Directors or C-suite audience. It should:
- Open with a single-sentence compliance posture statement (e.g., "The organisation's AML/KYC policy framework is partially compliant, scoring 52/100 against five Kenyan regulatory frameworks.")
- Identify the top 2-3 material risks with their regulatory citations
- Quantify the risk exposure (e.g., "3 CRITICAL gaps expose the organisation to potential licence suspension under CBK Prudential Guidelines")
- Close with a clear strategic recommendation (e.g., "Immediate Board attention is required on DPA 2019 compliance, with a 90-day remediation sprint recommended")
- Be 3-5 sentences total  -  concise but comprehensive

CRITICAL OUTPUT RULES:
1. Respond ONLY with valid JSON. No markdown fences, no preamble, no explanation outside JSON.
2. Every gap must cite a real, specific Kenyan regulatory provision (e.g., "DPA 2019, Section 32(1)(b)").
3. Do not fabricate gaps that do not exist based on the policy text provided.
4. Be specific about WHAT is missing in the policy, not generic statements.
5. Overall score must reflect actual gap severity  -  a policy with CRITICAL gaps cannot score above 50.
6. Every gap MUST have a non-empty evidenceRequired array, a non-empty responsibleRole string, and a non-empty regulatoryDeadline string. Do not leave these fields empty or omit them.

ADDITIONAL OUTPUT REQUIREMENTS:

For each gap identified, you MUST provide:
- evidenceRequired: An array of specific documents or artefacts the organisation must produce or maintain to close this gap. Be specific  -  not "update policies" but "Draft: Data Subject Access Request (DSAR) Procedure Document aligned to DPA 2019 Section 26" or "Obtain: Signed Data Processing Agreement with each third-party processor per DPA 2019 Section 31". Each item should start with a verb: Draft, Obtain, Implement, Review, Update, Establish, Document, Register.
- responsibleRole: The specific organisational role responsible for leading the remediation. Use standard titles: "Data Protection Officer (DPO)", "Chief Information Security Officer (CISO)", "Chief Compliance Officer (CCO)", "Chief Financial Officer (CFO)", "Head of Legal", "Head of IT/Engineering", "Board of Directors", "Head of Risk Management", "Head of Human Resources".
- regulatoryDeadline: If the regulation specifies a compliance deadline or timeline, state it explicitly with the source reference (e.g., "DPA 2019 Section 18  -  DPO registration with ODPC required before processing personal data", "Digital Credit Providers Regulations 2022  -  Licence application required per Regulation 4"). If no specific deadline exists, state "Ongoing obligation  -  continuous compliance required."

For each action plan item, you MUST include:
- responsibleRole: Same role assignment as above.
- dependsOn: An array of action titles (from other items in this action plan) that must be completed before this action can begin. Use an empty array [] if there are no dependencies. Example: "Implement DSAR response workflow" depends on "Draft DSAR Procedure Document".

KENYAN REGULATORY CONTEXT UPDATES:
Pay special attention to:
- ODPC Data Protection (General) Regulations 2021 (SI No. 3 of 2021)  -  implementing regulations under DPA 2019, covering data controller/processor registration, DPIA requirements, and breach notification timelines (72 hours to ODPC).
- Kenya Information and Communications Act (KICA)  -  cybersecurity obligations on providers of electronic communications services.
- CBK Guidance Note on Cybersecurity (CBS/PG/82)  -  specific cybersecurity requirements for banks and payment service providers regulated by CBK.`;
}

/**
 * User prompt for the first-pass per-chunk phase.
 * Only identifies gaps in the given chunk  -  no scoring or consolidation.
 */
export function generateChunkAnalysisUserPrompt(
  params: Omit<GapAnalysisParams, 'policyText'> & { chunkText: string },
  chunkIndex: number,
  totalChunks: number
): string {
  const ragSection = params.ragContext
    ? `\n## RETRIEVED REGULATORY CONTEXT\n${params.ragContext}\n`
    : `\n## NOTE: Regulatory document database unavailable. Use knowledge of current Kenyan regulations.\n`;

  const focusSection =
    params.focusAreas && params.focusAreas.length > 0
      ? `\n## PRIORITY FOCUS AREAS\nPay particular attention to: ${params.focusAreas.join(', ')}\n`
      : '';

  return `You are analysing CHUNK ${chunkIndex + 1} of ${totalChunks} of the document "${params.documentName}".
Identify ALL compliance gaps visible in this chunk against: ${params.regulatoryFrameworks.join(', ')}.
${ragSection}${focusSection}
## DOCUMENT CHUNK ${chunkIndex + 1} / ${totalChunks}
\`\`\`
${params.chunkText}
\`\`\`

Return a JSON array of gap objects found ONLY in this chunk. Each object:
{
  "framework": "<framework id e.g. DPA_2019>",
  "id": "<e.g. DPA-G001-C${chunkIndex + 1}>",
  "title": "...",
  "severity": "CRITICAL|HIGH|MEDIUM|LOW",
  "regulatoryBasis": "...",
  "description": "...",
  "policyCurrentState": "...",
  "recommendation": "...",
  "effort": "LOW|MEDIUM|HIGH",
  "priority": 1,
  "evidenceRequired": ["..."],
  "responsibleRole": "...",
  "regulatoryDeadline": "..."
}

Return [] if no gaps are found. Return ONLY a valid JSON array.`;
}

/**
 * User prompt for the second-pass consolidation merge.
 * Receives all raw per-chunk gaps and produces the full GapAnalysisResult.
 */
export function generateMergeUserPrompt(
  rawGaps: unknown[],
  params: Omit<GapAnalysisParams, 'policyText'> & { chunkCount: number }
): string {
  const ragSection = params.ragContext
    ? `\n## RETRIEVED REGULATORY CONTEXT\n${params.ragContext}\n`
    : '';

  const depthInstructions: Record<string, string> = {
    quick: 'Focus on CRITICAL and HIGH severity gaps. Merge minor duplicates aggressively.',
    standard: 'Cover all severity levels. Merge obvious duplicates.',
    deep: 'Retain all distinct gaps. Only merge exact duplicates.',
  };

  return `You have received pre-identified compliance gaps from a ${params.chunkCount}-chunk analysis of "${params.documentName}".
Your task: consolidate, de-duplicate, score, and produce the final GapAnalysisResult JSON.

Analysis depth: ${params.analysisDepth}  -  ${depthInstructions[params.analysisDepth] ?? depthInstructions.standard}
Frameworks: ${params.regulatoryFrameworks.join(', ')}
${ragSection}
## RAW GAPS FROM ALL CHUNKS (${(rawGaps as unknown[]).length} total  -  some may be duplicates)
\`\`\`json
${JSON.stringify(rawGaps, null, 2)}
\`\`\`

## CONSOLIDATION INSTRUCTIONS
1. De-duplicate gaps describing the same issue  -  keep the most detailed entry, reassign sequential priority numbers. If a gap was identified in multiple sections of the document, this STRENGTHENS the finding  -  do not discard it. Merge with the most complete description and the highest severity.
2. When merging duplicate gaps: combine their evidenceRequired arrays (deduplicate identical items), take the most specific regulatoryDeadline (prefer a concrete section citation over a generic statement), and use the most senior responsibleRole if chunks disagree.
3. Group final gaps by framework into the frameworks array.
4. Score each framework (0-100) based on severity/count of retained gaps.
5. Write a concise executiveSummary (2-4 sentences).
6. Build a prioritised actionPlan with dependsOn referencing other action titles or empty []. Every action plan item must include responsibleRole.
7. Set metadata.chunksProcessed = ${params.chunkCount}.
8. Recompute totalGaps, criticalGaps, highGaps from the final deduplicated list.

## REQUIRED JSON SCHEMA
\`\`\`json
${buildRequiredJsonSchema({ documentName: params.documentName, analysisDepth: params.analysisDepth, regulatoryFrameworks: params.regulatoryFrameworks })}
\`\`\`

Analyse EVERY specified framework  -  include frameworks with no gaps (score them high). Return ONLY valid JSON.`;
}

/**
 * User prompt for gap analysis  -  used for single-pass (document <= CHUNK_SIZE).
 */
export function generateGapAnalysisUserPrompt(params: GapAnalysisParams): string {
  const depthInstructions: Record<string, string> = {
    quick: 'Focus on CRITICAL and HIGH severity gaps only. Generate 2-3 gaps per framework maximum. Provide a high-level executive summary.',
    standard: 'Cover all severity levels. Generate 3-7 gaps per framework. Provide detailed analysis of each gap.',
    deep: 'Comprehensive analysis. Cover all severity levels thoroughly. Generate as many gaps as genuinely found (no limit). Provide granular analysis with specific policy excerpt references where possible.',
  };

  const ragSection = params.ragContext
    ? `\n\n## RETRIEVED REGULATORY CONTEXT\nThe following passages were retrieved from the Kenyan regulatory document database. Use these to ground your gap identification:\n\n${params.ragContext}\n`
    : `\n\n## NOTE: Regulatory document database context unavailable. Use your knowledge of current Kenyan regulations.\n`;

  const focusSection =
    params.focusAreas && params.focusAreas.length > 0
      ? `\n## PRIORITY FOCUS AREAS\nPay particular attention to these areas: ${params.focusAreas.join(', ')}\n`
      : '';

  return `Conduct a ${params.analysisDepth.toUpperCase()} gap analysis of the following policy document against the specified Kenyan regulatory frameworks.

## ANALYSIS SCOPE
- **Document:** ${params.documentName} (${params.documentType.toUpperCase()})
- **Regulatory Frameworks:** ${params.regulatoryFrameworks.join(', ')}
- **Analysis Depth:** ${params.analysisDepth}  -  ${depthInstructions[params.analysisDepth] ?? depthInstructions.standard}
${focusSection}${ragSection}

## POLICY DOCUMENT TO ANALYSE
\`\`\`
${params.policyText}
\`\`\`

## REQUIRED JSON SCHEMA
Return EXACTLY this structure. Populate ALL fields accurately:

\`\`\`json
${buildRequiredJsonSchema(params)}
\`\`\`

Analyse EVERY specified framework. Compute metadata counts from your actual gaps after writing all frameworks. Overall score = weighted average of framework scores, with CRITICAL gaps reducing it proportionally. Return ONLY valid JSON.`;
}

// --- Output Parser ------------------------------------------------------------

/**
 * Parse and validate AI gap analysis output using Zod (T3).
 * Falls back to regex JSON extraction if the response contains surrounding text.
 */
export function parseGapAnalysisOutput(rawContent: string): GapAnalysisResult {
  let content = rawContent.trim();

  // Strip markdown code fences if present
  if (content.startsWith('```')) {
    content = content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('AI response does not contain valid JSON');
    }
    parsed = JSON.parse(jsonMatch[0]);
  }

  // Zod validation  -  coerces defaults (evidenceRequired: [], dependsOn: [])
  const result = GapAnalysisResultSchema.safeParse(parsed);
  if (!result.success) {
    // Surface the first Zod error to help with debugging
    const firstError = result.error.issues[0];
    throw new Error(
      `Invalid gap analysis structure: ${firstError.path.join('.')}  -  ${firstError.message}`
    );
  }

  const validated = result.data;

  // Recompute metadata counts from actual validated gaps
  let totalGaps = 0;
  let criticalGaps = 0;
  let highGaps = 0;

  for (const framework of validated.frameworks) {
    totalGaps += framework.gaps.length;
    for (const gap of framework.gaps) {
      if (gap.severity === 'CRITICAL') criticalGaps++;
      if (gap.severity === 'HIGH') highGaps++;
    }
  }

  validated.metadata.totalGaps = totalGaps;
  validated.metadata.criticalGaps = criticalGaps;
  validated.metadata.highGaps = highGaps;
  validated.metadata.analysisDate = new Date().toISOString();

  // Clamp score to valid range (belt-and-suspenders, Zod already enforces min/max)
  validated.overallScore = Math.max(0, Math.min(100, Math.round(validated.overallScore)));

  return validated as GapAnalysisResult;
}

/**
 * Parse and validate the JSON array output from a single chunk analysis.
 * Each chunk prompt returns `[]` or an array of raw gap objects with an extra
 * `framework` field. Returns an empty array on an empty/null AI response rather
 * than throwing, so a single bad chunk does not abort the whole analysis.
 */
export function parseChunkAnalysisOutput(rawContent: string, chunkIndex: number): RawChunkGapItem[] {
  let content = rawContent.trim();

  // Strip markdown code fences if present
  if (content.startsWith('```')) {
    content = content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
  }

  // An empty or "no gaps" response is valid
  if (!content || content === '[]') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Try to extract a JSON array from surrounding text
    const arrayMatch = content.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      throw new Error(`Chunk ${chunkIndex}: AI response contains no valid JSON array`);
    }
    parsed = JSON.parse(arrayMatch[0]);
  }

  const result = ChunkOutputSchema.safeParse(parsed);
  if (!result.success) {
    const firstError = result.error.issues[0];
    throw new Error(
      `Chunk ${chunkIndex} validation failed: ${firstError.path.join('.')}  -  ${firstError.message}`
    );
  }

  return result.data;
}
