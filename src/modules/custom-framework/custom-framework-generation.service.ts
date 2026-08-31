import { z } from 'zod';
import { complete } from '@/lib/ai/client';
import { buildCitationsFromChunks, hasUsableCitations } from '@/lib/source-grounding/citations';
import { regulatoryIntelligenceService } from '@/modules/regulatory-intelligence/regulatory-intelligence.service';
import { runVerifierAgent } from '@/modules/compliance/orchestrator/verifier.agent';
import { extractJson } from '@/modules/compliance/orchestrator/utils';
import type { JurisdictionContext } from '@/types/jurisdiction';
import { logger } from '@/utils/logger';

const generatedFrameworkSchema = z.object({
  name: z.string().min(2).max(160),
  description: z.string().max(5000).optional(),
  sections: z.array(z.object({
    title: z.string().min(2).max(180),
    description: z.string().max(3000).optional(),
    controls: z.array(z.object({
      code: z.string().max(80).optional(),
      title: z.string().min(2).max(220),
      requirement: z.string().min(2).max(10000),
      guidance: z.string().max(10000).optional(),
      evidenceRequired: z.array(z.string()).default([]),
      severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional(),
      frequency: z.string().max(80).optional(),
      sourceIndex: z.number().int().min(1),
    })).min(1).max(30),
  })).min(1).max(12),
});

export type GeneratedCustomFramework = z.infer<typeof generatedFrameworkSchema>;

export class CustomFrameworkGenerationError extends Error {
  constructor(public readonly code: 'NO_ACCEPTED_EVIDENCE' | 'VERIFICATION_FAILURE' | 'PROVIDER_FAILURE') {
    super(code);
  }
}

export async function generateCustomFramework(input: {
  intent: string;
  organizationId: string;
  jurisdictionContext: JurisdictionContext;
}): Promise<{
  framework: GeneratedCustomFramework;
  evidence: Awaited<ReturnType<typeof regulatoryIntelligenceService.retrieveAndGrade>>['evidence'];
  citations: ReturnType<typeof buildCitationsFromChunks>;
  metadata: Record<string, unknown>;
}> {
  const intelligence = await regulatoryIntelligenceService.retrieveAndGrade({
    question: input.intent,
    feature: 'CUSTOM_FRAMEWORK',
    jurisdictionContext: input.jurisdictionContext,
    organizationContext: { organizationId: input.organizationId },
    retrievalProfile: { topK: 12, minScore: 0.65 },
  });
  if (!intelligence.grounded || intelligence.abstained || intelligence.evidence.length === 0) {
    throw new CustomFrameworkGenerationError('NO_ACCEPTED_EVIDENCE');
  }

  const citations = buildCitationsFromChunks(intelligence.evidence, 'verified');
  if (!hasUsableCitations(citations)) throw new CustomFrameworkGenerationError('NO_ACCEPTED_EVIDENCE');
  const evidenceText = intelligence.evidence.map((source, index) =>
    `[SOURCE ${index + 1}] ${source.documentTitle}; ${source.section ?? 'section unspecified'}; ` +
    `${source.citation ?? ''}\n${source.chunkText.slice(0, 1800)}`
  ).join('\n\n');

  let completion;
  try {
    completion = await complete({
      systemPrompt: `Generate a regulatory control framework using only the supplied same-country evidence.
Each control must be directly and fully entailed by one substantive SOURCE chunk and cite it by numeric sourceIndex.
Treat the intent as desired scope, not evidence: omit requested topics for which no source contains an operative requirement.
Never create a control from a table of contents, heading, policy objective, background statement, or general description.
Do not combine multiple sources, extrapolate implementation measures, broaden a claim, or invent legal duties.
Keep each requirement evidence-close. Omit guidance, frequency, severity, and evidenceRequired unless that same source explicitly supports them.
Return JSON only.`,
      prompt: `Intent: ${input.intent}\n\nEvidence:\n${evidenceText}\n\nReturn {"name":"...","description":"...","sections":[{"title":"...","description":"...","controls":[{"code":"...","title":"...","requirement":"one narrow obligation directly stated in the mapped source","sourceIndex":1}]}]}`,
      maxTokens: 8192,
      temperature: 0,
    }, 'policy');
  } catch {
    throw new CustomFrameworkGenerationError('PROVIDER_FAILURE');
  }

  let framework: GeneratedCustomFramework;
  try {
    framework = generatedFrameworkSchema.parse(JSON.parse(extractJson(completion.content)));
  } catch {
    throw new CustomFrameworkGenerationError('PROVIDER_FAILURE');
  }
  if (framework.sections.some((section) => section.controls.some((control) => control.sourceIndex > intelligence.evidence.length))) {
    throw new CustomFrameworkGenerationError('VERIFICATION_FAILURE');
  }

  const controls = framework.sections.flatMap((section) => section.controls);
  const verificationResults = [];
  for (const control of controls) {
    const source = intelligence.evidence[control.sourceIndex - 1];
    const answer = [control.title, control.requirement, control.guidance].filter(Boolean).join('\n');
    const verifier = await runVerifierAgent(answer, [source], input.jurisdictionContext);
    verificationResults.push({ control, source, verifier });
  }

  const rejectedControls = verificationResults.filter(({ verifier }) =>
    verifier.verdict !== 'PASS' || verifier.parseFailed || verifier.unsupportedClaims.length > 0
  );

  logger.info({
    type: 'custom_framework_control_verification',
    retrievedChunks: intelligence.retrievedCount,
    approvedEligible: intelligence.evidence.length,
    graderAccepted: intelligence.acceptedCount,
    generatedControls: controls.length,
    controlsVerified: controls.length - rejectedControls.length,
    controlsRejected: rejectedControls.length,
    rejected: rejectedControls.map(({ control, source, verifier }) => ({
      controlIdentifier: control.code ?? control.title.slice(0, 80),
      reason: verifier.parseFailed
        ? 'VERIFIER_PARSE_FAILED'
        : verifier.unsupportedClaims[0]?.slice(0, 160) ?? verifier.verdict,
      documentId: source.documentId,
      chunkId: source.chunkId,
      vectorId: source.vectorId,
    })),
  });

  if (rejectedControls.length > 0) {
    throw new CustomFrameworkGenerationError('VERIFICATION_FAILURE');
  }

  return {
    framework,
    evidence: intelligence.evidence,
    citations,
    metadata: {
      runId: intelligence.runId,
      jurisdictionCode: input.jurisdictionContext.mode === 'SINGLE' ? input.jurisdictionContext.primaryJurisdiction : null,
      retrievedChunks: intelligence.retrievedCount,
      acceptedChunks: intelligence.acceptedCount,
      rejectedChunks: intelligence.rejectedCount,
      verifierStatus: 'PASS',
      generatedControls: controls.length,
      controlsVerified: controls.length,
      controlsRejected: 0,
      unsupportedClaims: [],
      corpusVersionSnapshot: intelligence.corpusVersionSnapshot,
      retrievalVersion: intelligence.retrievalVersion,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      estimatedCostUsd: completion.cost,
    },
  };
}
