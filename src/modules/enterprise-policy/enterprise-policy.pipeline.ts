import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { aiService } from '@/lib/ai/ai.service';
import { ragService, type SearchResult } from '@/lib/rag/rag.service';
import { buildCitationsFromChunks, hasUsableCitations } from '@/lib/source-grounding/citations';
import { POLICY_SOURCE_INSUFFICIENCY_MESSAGE, SourceInsufficiencyError } from '@/lib/source-grounding/source-insufficiency';
import { logger } from '@/utils/logger';

type JobLike = {
  id: string;
  targetEntityId: string;
  userId: string | null;
  organizationId: string | null;
  payload: Prisma.JsonValue;
};

type ProgressFn = (
  progress: number,
  message: string,
  metadata?: Prisma.InputJsonValue,
) => Promise<void>;

type EnterprisePolicyPayload = {
  policyType: string;
  title: string;
  description?: string;
  targetAudience?: string;
  organizationType?: string;
  regulatoryFrameworks: string[];
  jurisdiction: string;
  sourceGapAnalysisId?: string;
  sourceGapId?: string;
};

function payloadAsObject(payload: Prisma.JsonValue): EnterprisePolicyPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid enterprise policy job payload.');
  }
  const value = payload as Record<string, unknown>;
  return {
    policyType: String(value.policyType ?? 'CUSTOM'),
    title: String(value.title ?? 'Generated Policy'),
    description: typeof value.description === 'string' ? value.description : undefined,
    targetAudience: typeof value.targetAudience === 'string' ? value.targetAudience : undefined,
    organizationType: typeof value.organizationType === 'string' ? value.organizationType : undefined,
    regulatoryFrameworks: Array.isArray(value.regulatoryFrameworks)
      ? value.regulatoryFrameworks.map(String)
      : [],
    jurisdiction: String(value.jurisdiction ?? 'Kenya'),
    sourceGapAnalysisId: typeof value.sourceGapAnalysisId === 'string' ? value.sourceGapAnalysisId : undefined,
    sourceGapId: typeof value.sourceGapId === 'string' ? value.sourceGapId : undefined,
  };
}

function markdownToTipTap(content: string): Prisma.InputJsonValue {
  return {
    type: 'doc',
    content: content
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .map((paragraph) => ({
        type: 'paragraph',
        content: [{ type: 'text', text: paragraph }],
      })),
  };
}

function buildScenario(input: EnterprisePolicyPayload): string {
  return [
    `Generate an enterprise ${input.policyType.replace(/_/g, ' ').toLowerCase()} policy titled "${input.title}".`,
    input.description ? `Scope notes: ${input.description}` : null,
    `Jurisdiction: ${input.jurisdiction}.`,
    input.regulatoryFrameworks.length ? `Frameworks: ${input.regulatoryFrameworks.join(', ')}.` : null,
  ].filter(Boolean).join('\n');
}

function contentHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function buildEnterprisePolicySources(frameworks: string[]): Promise<{ context: string | undefined; results: SearchResult[] }> {
  const chunks: string[] = [];
  const acceptedResults: SearchResult[] = [];
  const seen = new Set<string>();

  for (const framework of frameworks) {
    const results = await ragService.search(`${framework} Kenya regulatory requirements policy obligations`, {
      topK: 5,
      minScore: 0.7,
    });

    for (const result of results) {
      const key = `${result.documentId}:${result.section ?? ''}:${result.chunkText.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      acceptedResults.push(result);
      chunks.push(
        `[SOURCE: ${result.documentTitle}${result.section ? ` - ${result.section}` : ''}]\n${result.chunkText}`
      );
    }
  }

  return {
    context: chunks.length > 0 ? chunks.join('\n\n---\n\n') : undefined,
    results: acceptedResults,
  };
}

export async function runEnterprisePolicyJob(job: JobLike, progress: ProgressFn): Promise<void> {
  const input = payloadAsObject(job.payload);
  const policyId = job.targetEntityId;

  await progress(5, 'Enterprise policy pipeline started.', { policyId });
  await prisma.generatedPolicy.update({
    where: { id: policyId },
    data: { status: 'OUTLINING', progress: 10, errorMessage: null },
  });
  await prisma.generatedPolicyGenerationEvent.create({
    data: {
      generatedPolicyId: policyId,
      jobId: job.id,
      stage: 'OUTLINING',
      metadata: { policyType: input.policyType, frameworks: input.regulatoryFrameworks },
    },
  });

  const frameworkSnapshots = await prisma.regulatoryFramework.findMany({
    where: {
      OR: [
        { slug: { in: input.regulatoryFrameworks } },
        { name: { in: input.regulatoryFrameworks } },
      ],
    },
    select: { id: true, slug: true, name: true, category: true, tier: true },
  });

  await progress(20, 'Generating policy content.', { frameworkCount: frameworkSnapshots.length });
  await prisma.generatedPolicy.update({
    where: { id: policyId },
    data: { status: 'DRAFTING', progress: 25 },
  });

  const policySources = await buildEnterprisePolicySources(input.regulatoryFrameworks);
  const sourceCitations = buildCitationsFromChunks(policySources.results, 'verified');
  if (!policySources.context || !hasUsableCitations(sourceCitations)) {
    throw new SourceInsufficiencyError(POLICY_SOURCE_INSUFFICIENCY_MESSAGE);
  }

  const result = await aiService.generatePolicy({
    scenario: buildScenario(input),
    organizationType: (input.organizationType ?? 'OTHER') as never,
    regulatoryAreas: input.regulatoryFrameworks as never,
    specificRequirements: input.description,
    targetAudience: input.targetAudience ?? 'All employees',
    ragContext: policySources.context,
  }, policyId);

  const sectionPairs = [
    ['executive-summary', 'Executive Summary', result.sections.executiveSummary],
    ['regulatory-landscape', 'Regulatory Landscape', result.sections.regulatoryLandscape],
    ['recommendations', 'Recommendations', result.sections.recommendations],
    ['compliance-checklist', 'Compliance Checklist', result.sections.complianceChecklist],
    ['risk-assessment', 'Risk Assessment', result.sections.riskAssessment],
    ['implementation-roadmap', 'Implementation Roadmap', result.sections.implementationRoadmap],
  ].filter(([, , content]) => typeof content === 'string' && content.trim().length > 0);

  const tableOfContents = {
    sections: sectionPairs.map(([id, title, content]) => ({
      id,
      title,
      description: `Generated ${title.toLowerCase()} section.`,
      estimatedWordCount: String(content).split(/\s+/).filter(Boolean).length,
      mandatoryClauses: [],
    })),
  };

  const sections = sectionPairs.map(([id, title, content]) => ({
    id,
    title,
    content: markdownToTipTap(String(content)),
    contentMarkdown: String(content),
    citations: sourceCitations.map((citation) => citation.citation ?? citation.documentTitle),
    status: 'generated',
    wordCount: String(content).split(/\s+/).filter(Boolean).length,
  }));

  await progress(75, 'Persisting source and citation audit records.', {
    citationCount: sourceCitations.length,
  });
  await prisma.generatedPolicy.update({
    where: { id: policyId },
    data: { status: 'REVIEWING', progress: 80 },
  });

  const sourceSnapshots = await Promise.all([
    ...frameworkSnapshots.map((framework) =>
      prisma.generatedPolicySourceSnapshot.create({
        data: {
          generatedPolicyId: policyId,
          sourceType: 'REGULATORY_FRAMEWORK',
          title: framework.name,
          slug: framework.slug,
          metadata: {
            frameworkId: framework.id,
            category: framework.category,
            tier: framework.tier,
            requestedFrameworks: input.regulatoryFrameworks,
          },
        },
      })
    ),
    input.sourceGapAnalysisId
      ? prisma.generatedPolicySourceSnapshot.create({
          data: {
            generatedPolicyId: policyId,
            sourceType: 'GAP_ANALYSIS',
            title: `Gap analysis ${input.sourceGapAnalysisId}`,
            slug: input.sourceGapId ?? null,
            metadata: {
              sourceGapAnalysisId: input.sourceGapAnalysisId,
              sourceGapId: input.sourceGapId,
            },
          },
        })
      : Promise.resolve(null),
  ]);

  const firstSnapshot = sourceSnapshots.find((snapshot): snapshot is NonNullable<typeof snapshot> => !!snapshot);
  await prisma.generatedPolicyCitation.deleteMany({ where: { generatedPolicyId: policyId } });
  await prisma.generatedPolicyCitation.createMany({
    data: sourceCitations.map((citation, index) => ({
      generatedPolicyId: policyId,
      sectionId: 'document',
      actName: citation.documentTitle,
      section: citation.section,
      textSnippet: citation.textSnippet,
      confidence: 'high',
      verified: true,
      citationVerified: true,
      rawSource: {
        index,
        citation,
        contentHash: contentHash(citation.textSnippet),
      },
      sourceSnapshotId: firstSnapshot?.id ?? null,
    })),
  });

  await prisma.generatedPolicyGenerationEvent.create({
    data: {
      generatedPolicyId: policyId,
      jobId: job.id,
      stage: 'DRAFTING',
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.cost,
      metadata: { cached: result.cached ?? false, stopReason: result.stopReason ?? null },
    },
  });

  const generationMetadata = {
    jobId: job.id,
    model: result.model,
    totalTokensUsed: result.inputTokens + result.outputTokens,
    totalCostUsd: result.cost,
    generatedAt: new Date().toISOString(),
    contentHash: contentHash(result.content),
    sourceSnapshotCount: sourceSnapshots.filter(Boolean).length,
    citationCount: sourceCitations.length,
  };

  await prisma.generatedPolicy.update({
    where: { id: policyId },
    data: {
      status: 'COMPLETED',
      progress: 100,
      tableOfContents,
      sections,
      executiveSummary: result.sections.executiveSummary || result.content.slice(0, 1200),
      reviewNotes: result.followUpQuestions?.length
        ? `Suggested review questions:\n${result.followUpQuestions.map((q) => `- ${q}`).join('\n')}`
        : null,
      generationMetadata,
      completedAt: new Date(),
    },
  });

  await prisma.generatedPolicyGenerationEvent.create({
    data: {
      generatedPolicyId: policyId,
      jobId: job.id,
      stage: 'COMPLETED',
      model: result.model,
      metadata: generationMetadata,
    },
  });

  logger.info({
    type: 'enterprise_policy_pipeline_completed',
    policyId,
    jobId: job.id,
    userId: job.userId,
    organizationId: job.organizationId,
  });
}
