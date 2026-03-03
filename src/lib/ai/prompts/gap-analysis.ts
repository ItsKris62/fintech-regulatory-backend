/**
 * Gap Analysis Generation Prompts
 * AI prompts for comparing uploaded policy documents against
 * Kenyan regulatory requirements using RAG-retrieved context.
 */

// ─── Input Types ─────────────────────────────────────────────────────────────

export interface GapAnalysisParams {
  policyText: string;
  documentName: string;
  documentType: string;
  regulatoryFrameworks: string[];
  analysisDepth: 'quick' | 'standard' | 'deep';
  focusAreas?: string[];
  ragContext?: string; // Retrieved regulatory passages from Pinecone
}

// ─── Output Types ─────────────────────────────────────────────────────────────

export interface GapItem {
  id: string;
  title: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  regulatoryBasis: string;
  description: string;
  policyCurrentState: string;
  recommendation: string;
  effort: 'LOW' | 'MEDIUM' | 'HIGH';
  priority: number;
}

export interface FrameworkResult {
  id: string;
  name: string;
  score: number;
  gaps: GapItem[];
  strengths: string[];
  summary: string;
}

export interface ActionPlanItem {
  priority: number;
  action: string;
  framework: string;
  deadline: string;
  effort: 'LOW' | 'MEDIUM' | 'HIGH';
  resources: string[];
}

export interface GapAnalysisResult {
  overallScore: number;
  executiveSummary: string;
  frameworks: FrameworkResult[];
  crossCuttingStrengths: string[];
  actionPlan: ActionPlanItem[];
  metadata: {
    documentName: string;
    analysisDepth: string;
    frameworksAnalysed: string[];
    totalGaps: number;
    criticalGaps: number;
    highGaps: number;
    analysisDate: string;
  };
}

// ─── Prompt Builders ─────────────────────────────────────────────────────────

/**
 * System prompt for gap analysis.
 */
export function generateGapAnalysisSystemPrompt(): string {
  return `You are a senior Kenyan financial regulatory compliance auditor with 15+ years of experience. You specialise in reviewing internal compliance policies and procedures against Kenyan regulatory requirements.

Your expertise covers:
- Data Protection Act 2019 (DPA) and ODPC guidelines
- CBK Prudential Guidelines and Banking Act
- National Payment System Act 2011 and subsidiary legislation
- Proceeds of Crime and Anti-Money Laundering Act (POCAMLA)
- CBK Cybersecurity Guidance Note 2023
- Consumer Protection Act and CBK consumer protection guidelines
- Capital Markets Authority (CMA) Act and Regulations
- Digital Credit Providers Regulations 2022
- Computer Misuse and Cybercrimes Act 2018

Your task is to conduct a rigorous gap analysis of the provided policy document(s) against the specified regulatory frameworks. You must:
1. Identify specific gaps where the policy fails to meet regulatory requirements
2. Cite the exact Kenyan law section that creates each obligation
3. Rate severity accurately: CRITICAL = legal exposure/licence risk; HIGH = likely regulatory finding; MEDIUM = best-practice gap; LOW = minor improvement
4. Identify genuine strengths to give a balanced assessment
5. Calculate a realistic compliance score (0-100) per framework and overall

CRITICAL OUTPUT RULES:
1. Respond ONLY with valid JSON. No markdown fences, no preamble, no explanation outside JSON.
2. Every gap must cite a real, specific Kenyan regulatory provision (e.g., "DPA 2019, Section 32(1)(b)").
3. Do not fabricate gaps that do not exist based on the policy text provided.
4. Be specific about WHAT is missing in the policy, not generic statements.
5. Overall score must reflect actual gap severity — a policy with CRITICAL gaps cannot score above 50.`;
}

/**
 * User prompt for gap analysis with policy text and regulatory context.
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

  const focusSection = params.focusAreas && params.focusAreas.length > 0
    ? `\n## PRIORITY FOCUS AREAS\nPay particular attention to these areas: ${params.focusAreas.join(', ')}\n`
    : '';

  // Truncate policy text if too large (keep first 15,000 chars for deep, 8,000 for others)
  const maxPolicyChars = params.analysisDepth === 'deep' ? 15000 : 8000;
  const policyText = params.policyText.length > maxPolicyChars
    ? params.policyText.slice(0, maxPolicyChars) + '\n\n[... document truncated for analysis ...]'
    : params.policyText;

  return `Conduct a ${params.analysisDepth.toUpperCase()} gap analysis of the following policy document against the specified Kenyan regulatory frameworks.

## ANALYSIS SCOPE
- **Document:** ${params.documentName} (${params.documentType.toUpperCase()})
- **Regulatory Frameworks:** ${params.regulatoryFrameworks.join(', ')}
- **Analysis Depth:** ${params.analysisDepth} — ${depthInstructions[params.analysisDepth] || depthInstructions.standard}
${focusSection}${ragSection}

## POLICY DOCUMENT TO ANALYSE
\`\`\`
${policyText}
\`\`\`

## REQUIRED JSON SCHEMA
Return EXACTLY this structure. Populate ALL fields accurately:

\`\`\`json
{
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
          "regulatoryBasis": "Data Protection Act 2019, Section 26 — Right of access; Section 30 — Right to erasure",
          "description": "The policy does not define procedures for handling data subject requests (access, rectification, erasure, objection). The DPA requires responses within 21 days.",
          "policyCurrentState": "Policy mentions 'we respect privacy' but contains no operational procedure for handling subject rights requests.",
          "recommendation": "Draft and implement a Data Subject Rights Procedure covering: request intake form, 21-day response SLA, escalation process, and rejection grounds as per DPA Section 26-32.",
          "effort": "MEDIUM",
          "priority": 1
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
      "resources": ["DPO or external data protection counsel", "DPA 2019 Sections 26-32", "ODPC guidance on subject rights"]
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
}
\`\`\`

Analyse EVERY specified framework. Compute metadata counts from your actual gaps after writing all frameworks. Overall score = weighted average of framework scores, with CRITICAL gaps reducing it proportionally. Return ONLY valid JSON.`;
}

/**
 * Parse and validate AI gap analysis output.
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

  let parsed: GapAnalysisResult;
  try {
    parsed = JSON.parse(content) as GapAnalysisResult;
  } catch {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('AI response does not contain valid JSON');
    }
    parsed = JSON.parse(jsonMatch[0]) as GapAnalysisResult;
  }

  if (!parsed.frameworks || !Array.isArray(parsed.frameworks)) {
    throw new Error('Invalid gap analysis structure: missing frameworks array');
  }
  if (typeof parsed.overallScore !== 'number') {
    throw new Error('Invalid gap analysis structure: missing overallScore');
  }

  // Recompute metadata counts
  let totalGaps = 0;
  let criticalGaps = 0;
  let highGaps = 0;

  for (const framework of parsed.frameworks) {
    if (!Array.isArray(framework.gaps)) continue;
    totalGaps += framework.gaps.length;
    for (const gap of framework.gaps) {
      if (gap.severity === 'CRITICAL') criticalGaps++;
      if (gap.severity === 'HIGH') highGaps++;
    }
  }

  if (!parsed.metadata) {
    parsed.metadata = {
      documentName: '',
      analysisDepth: 'standard',
      frameworksAnalysed: [],
      totalGaps,
      criticalGaps,
      highGaps,
      analysisDate: new Date().toISOString(),
    };
  } else {
    parsed.metadata.totalGaps = totalGaps;
    parsed.metadata.criticalGaps = criticalGaps;
    parsed.metadata.highGaps = highGaps;
    parsed.metadata.analysisDate = new Date().toISOString();
  }

  // Clamp score to valid range
  parsed.overallScore = Math.max(0, Math.min(100, Math.round(parsed.overallScore)));

  return parsed;
}
