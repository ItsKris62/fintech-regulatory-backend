import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { aiService } from '@/lib/ai/ai.service';
import { policyCache } from '@/lib/redis/cache.service';
import { policyProgressPubSub } from '@/lib/redis/pubsub';
import { mailer } from '@/lib/email/mailer.service';
import { logger } from '@/utils/logger';

type JobLike = {
  id: string;
  targetEntityId: string;
  userId: string | null;
  payload: Prisma.JsonValue;
};

type ProgressFn = (
  progress: number,
  message: string,
  metadata?: Prisma.InputJsonValue,
) => Promise<void>;

type PolicyGenerationPayload = {
  scenario: string;
  organizationType: string;
  regulatoryAreas: string[];
  specificRequirements?: string;
  targetAudience?: string;
  requestedByEmail?: string;
};

function parsePayload(payload: Prisma.JsonValue): PolicyGenerationPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid policy generation payload.');
  }
  const value = payload as Record<string, unknown>;
  return {
    scenario: String(value.scenario ?? ''),
    organizationType: String(value.organizationType ?? 'OTHER'),
    regulatoryAreas: Array.isArray(value.regulatoryAreas) ? value.regulatoryAreas.map(String) : [],
    specificRequirements: typeof value.specificRequirements === 'string' ? value.specificRequirements : undefined,
    targetAudience: typeof value.targetAudience === 'string' ? value.targetAudience : undefined,
    requestedByEmail: typeof value.requestedByEmail === 'string' ? value.requestedByEmail : undefined,
  };
}

export async function runPolicyGenerationJob(job: JobLike, progress: ProgressFn): Promise<void> {
  const input = parsePayload(job.payload);
  const policyId = job.targetEntityId;
  const startTime = Date.now();

  await progress(10, 'Starting policy generation.');
  await policyProgressPubSub.publish(policyId, {
    type: 'generation_started',
    progress: 10,
    message: 'Starting policy generation...',
  });

  const result = await aiService.generatePolicy({
    scenario: input.scenario,
    organizationType: input.organizationType as never,
    regulatoryAreas: input.regulatoryAreas as never,
    specificRequirements: input.specificRequirements,
    targetAudience: input.targetAudience as never,
  });

  await progress(70, 'Policy content generated, adding citations.', {
    citationCount: result.sections.citations.length,
  });
  await policyProgressPubSub.publish(policyId, {
    type: 'generating_recommendations',
    progress: 70,
    message: 'Policy content generated, adding citations...',
  });

  await prisma.citation.createMany({
    data: (result.sections.citations || []).map((citationText: string) => {
      const actNameMatch = citationText.match(/^([^,(]+)/);
      const actName = actNameMatch ? actNameMatch[1].trim() : citationText.slice(0, 100);
      return {
        policyId,
        actName,
        section: '',
        textSnippet: citationText,
        confidence: 'high',
        verified: true,
      };
    }),
  });

  const updatedPolicy = await prisma.policy.update({
    where: { id: policyId },
    data: {
      content: result.content,
      executiveSummary: result.sections.executiveSummary,
      analysis: result.sections.regulatoryLandscape,
      status: 'COMPLETED',
      generationMetadata: {
        jobId: job.id,
        aiModel: result.model,
        tokensUsed: result.inputTokens + result.outputTokens,
        generatedAt: new Date().toISOString(),
      },
    },
    include: { citations: true },
  });

  await policyCache.delete(policyId);

  const user = job.userId
    ? await prisma.user.findUnique({ where: { id: job.userId }, select: { email: true, fullName: true } })
    : null;

  try {
    await mailer.sendPolicyReadyEmail({
      to: input.requestedByEmail ?? user?.email ?? '',
      name: user?.fullName ?? user?.email ?? 'SheriaBot user',
      policyTitle: updatedPolicy.title ?? 'Policy',
      policyId: updatedPolicy.id,
      policyUrl: '',
      regulatoryAreas: [],
      generationTime: Date.now() - startTime,
    } as never);
  } catch (emailError) {
    logger.error({
      type: 'policy_email_failed',
      policyId,
      error: emailError instanceof Error ? emailError.message : String(emailError),
    });
  }

  await progress(100, 'Policy generated successfully.');
  await policyProgressPubSub.publish(policyId, {
    type: 'generation_complete',
    progress: 100,
    message: 'Policy generated successfully!',
  });

  logger.info({
    type: 'policy_generation_success',
    userId: job.userId,
    policyId,
    jobId: job.id,
    duration: Date.now() - startTime,
    tokensUsed: result.inputTokens + result.outputTokens,
  });
}
