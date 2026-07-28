import { describe, expect, it, vi, afterEach } from 'vitest';
import type { AgentRun } from '@prisma/client';
import { appConfig } from '@/config/app.config';
import type { prisma as appPrisma } from '@/lib/prisma/client';
import type { AgentRunService } from '@/modules/agents/agent-run.service';
import { createSuggestionFromSourceItem } from '@/modules/blog-automation/suggestion-builder';
import { createBlogDraftFromSuggestion } from '@/modules/blog-automation/draft-creation.service';
import { generateAiDraftForBlogPost } from '@/modules/blog-automation/ai-draft-generation.service';
import type { ContentOpsAlertService } from './content-ops-alert.service';
import { AutomationBlogDraftService } from './blog-draft.service';

type FullPrisma = typeof appPrisma;

const NOW = new Date('2026-07-24T09:00:00.000Z');
const AGENT_USER_ID = 'sys-automation-orchestrator';

function buildService(overrides: {
  createSuggestion?: ReturnType<typeof vi.fn>;
  createDraft?: ReturnType<typeof vi.fn>;
  updateSuggestion?: ReturnType<typeof vi.fn>;
  generateDraft?: ReturnType<typeof vi.fn>;
  agentRuns?: { beginRun: ReturnType<typeof vi.fn>; completeRun: ReturnType<typeof vi.fn>; failRun: ReturnType<typeof vi.fn> };
  createOrIncrementAlert?: ReturnType<typeof vi.fn>;
} = {}) {
  const updateSuggestion = overrides.updateSuggestion ?? vi.fn().mockResolvedValue({});
  const prisma = {
    blogArticleSuggestion: { update: updateSuggestion },
  } as unknown as FullPrisma;

  const agentRuns = (overrides.agentRuns ?? {
    beginRun: vi.fn(),
    completeRun: vi.fn(),
    failRun: vi.fn(),
  }) as unknown as AgentRunService;

  const createOrIncrementAlert = overrides.createOrIncrementAlert ?? vi.fn().mockResolvedValue(undefined);
  const contentOpsAlert = { createOrIncrementAlert } as unknown as ContentOpsAlertService;

  const service = new AutomationBlogDraftService({
    prisma,
    createSuggestion: overrides.createSuggestion as unknown as typeof createSuggestionFromSourceItem | undefined,
    createDraft: overrides.createDraft as unknown as typeof createBlogDraftFromSuggestion | undefined,
    generateDraft: overrides.generateDraft as unknown as typeof generateAiDraftForBlogPost | undefined,
    agentRuns,
    contentOpsAlert,
    now: () => NOW,
  });

  return { service, updateSuggestion, prisma, agentRuns, createOrIncrementAlert };
}

function fakeAgentRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run_1',
    agentType: 'automation',
    idempotencyKey: 'idem_1',
    status: 'RUNNING',
    organizationId: null,
    metadata: null,
    estimatedCostUsd: null,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    iterations: 0,
    error: null,
    createdAt: NOW,
    completedAt: null,
    ...overrides,
  } as unknown as AgentRun;
}

describe('AutomationBlogDraftService.createDraftFromCandidate', () => {
  it('returns below_threshold and never touches suggestion/draft creation when scoring rejects the item', async () => {
    const createSuggestion = vi.fn().mockResolvedValue({ createdSuggestion: false, suggestion: null });
    const createDraft = vi.fn();
    const { service, updateSuggestion, createOrIncrementAlert } = buildService({ createSuggestion, createDraft });

    const result = await service.createDraftFromCandidate({ sourceItemId: 'src_1' }, AGENT_USER_ID);

    expect(result).toEqual({ status: 'below_threshold' });
    expect(updateSuggestion).not.toHaveBeenCalled();
    expect(createDraft).not.toHaveBeenCalled();
    expect(createOrIncrementAlert).not.toHaveBeenCalled();
  });

  it('returns duplicate when the source item was already converted to a suggestion', async () => {
    const createSuggestion = vi.fn().mockResolvedValue({ createdSuggestion: false, suggestion: null, reason: 'Duplicate' });
    const { service } = buildService({ createSuggestion });

    const result = await service.createDraftFromCandidate({ sourceItemId: 'src_1' }, AGENT_USER_ID);

    expect(result).toEqual({ status: 'duplicate' });
  });

  it('does not pass createdByUserId through to createSuggestionFromSourceItem', async () => {
    const createSuggestion = vi.fn().mockResolvedValue({ createdSuggestion: false, suggestion: null });
    const { service } = buildService({ createSuggestion });

    await service.createDraftFromCandidate({ sourceItemId: 'src_1' }, AGENT_USER_ID);

    expect(createSuggestion).toHaveBeenCalledWith(
      expect.objectContaining({ sourceItemId: 'src_1' }),
    );
    const callArgs = createSuggestion.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty('createdByUserId');
  });

  it('promotes the created suggestion straight to APPROVED_FOR_DRAFT, attributed to the agent principal, then creates the draft', async () => {
    const suggestion = { id: 'sug_1', priority: 'MEDIUM', title: 'New CBK Circular' };
    const createSuggestion = vi.fn().mockResolvedValue({ createdSuggestion: true, suggestion });
    const createDraft = vi.fn().mockResolvedValue({ blogPostId: 'post_1', slug: 'post-1' });
    const { service, updateSuggestion } = buildService({ createSuggestion, createDraft });

    const result = await service.createDraftFromCandidate({ sourceItemId: 'src_1' }, AGENT_USER_ID);

    expect(updateSuggestion).toHaveBeenCalledWith({
      where: { id: 'sug_1' },
      data: { status: 'APPROVED_FOR_DRAFT', approvedAt: NOW, approvedById: AGENT_USER_ID },
    });
    expect(createDraft).toHaveBeenCalledWith({
      prisma: expect.anything(),
      suggestionId: 'sug_1',
      createdById: AGENT_USER_ID,
    });
    expect(result).toEqual({ status: 'created', suggestionId: 'sug_1', blogPostId: 'post_1', slug: 'post-1' });
  });

  it('promotes the suggestion before creating the draft, not after (draft creation requires APPROVED_FOR_DRAFT)', async () => {
    const suggestion = { id: 'sug_1', priority: 'MEDIUM', title: 'New CBK Circular' };
    const callOrder: string[] = [];
    const createSuggestion = vi.fn().mockResolvedValue({ createdSuggestion: true, suggestion });
    const updateSuggestion = vi.fn().mockImplementation(async () => {
      callOrder.push('approve');
      return {};
    });
    const createDraft = vi.fn().mockImplementation(async () => {
      callOrder.push('createDraft');
      return { blogPostId: 'post_1', slug: 'post-1' };
    });
    const { service } = buildService({ createSuggestion, createDraft, updateSuggestion });

    await service.createDraftFromCandidate({ sourceItemId: 'src_1' }, AGENT_USER_ID);

    expect(callOrder).toEqual(['approve', 'createDraft']);
  });

  it.each([
    ['HIGH', 'HIGH'],
    ['URGENT', 'CRITICAL'],
  ])(
    'persists a content ops alert (severity %s -> %s) for high-priority suggestions, not derived per-monitor',
    async (priority, expectedSeverity) => {
      const suggestion = { id: 'sug_1', priority, title: 'New CBK Circular' };
      const createSuggestion = vi.fn().mockResolvedValue({ createdSuggestion: true, suggestion });
      const createDraft = vi.fn().mockResolvedValue({ blogPostId: 'post_1', slug: 'post-1' });
      const { service, createOrIncrementAlert } = buildService({ createSuggestion, createDraft });

      await service.createDraftFromCandidate({ sourceItemId: 'src_1' }, AGENT_USER_ID);

      expect(createOrIncrementAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'high_priority_suggestion_drafted',
          severity: expectedSeverity,
          entityType: 'BlogPost',
          entityId: 'post_1',
          title: 'High Priority Blog Suggestion',
        }),
      );
    },
  );

  it.each(['LOW', 'MEDIUM'])('does not persist a content ops alert for %s-priority suggestions', async (priority) => {
    const suggestion = { id: 'sug_1', priority, title: 'New CBK Circular' };
    const createSuggestion = vi.fn().mockResolvedValue({ createdSuggestion: true, suggestion });
    const createDraft = vi.fn().mockResolvedValue({ blogPostId: 'post_1', slug: 'post-1' });
    const { service, createOrIncrementAlert } = buildService({ createSuggestion, createDraft });

    await service.createDraftFromCandidate({ sourceItemId: 'src_1' }, AGENT_USER_ID);

    expect(createOrIncrementAlert).not.toHaveBeenCalled();
  });

  describe('requiresHumanReview enforcement (Pack 1 Stage C3)', () => {
    const reviewRequiredSuggestion = {
      id: 'sug_1',
      priority: 'URGENT',
      title: 'New CBK Circular',
      requiresHumanReview: true,
      category: 'Regulatory Updates',
      requiresOfficialSource: true,
      sourceQuality: 'MEDIUM',
      jurisdiction: 'KE',
    };

    afterEach(() => {
      (appConfig.editorial as any).humanReviewEnforcementEnabled = false;
    });

    it('preserves current auto-promotion behavior when enforcement is disabled, even for a requiresHumanReview=true suggestion', async () => {
      (appConfig.editorial as any).humanReviewEnforcementEnabled = false;
      const createSuggestion = vi.fn().mockResolvedValue({ createdSuggestion: true, suggestion: reviewRequiredSuggestion });
      const createDraft = vi.fn().mockResolvedValue({ blogPostId: 'post_1', slug: 'post-1' });
      const { service, updateSuggestion } = buildService({ createSuggestion, createDraft });

      const result = await service.createDraftFromCandidate({ sourceItemId: 'src_1' }, AGENT_USER_ID);

      expect(updateSuggestion).toHaveBeenCalledWith({
        where: { id: 'sug_1' },
        data: { status: 'APPROVED_FOR_DRAFT', approvedAt: NOW, approvedById: AGENT_USER_ID },
      });
      expect(createDraft).toHaveBeenCalled();
      expect(result).toEqual({ status: 'created', suggestionId: 'sug_1', blogPostId: 'post_1', slug: 'post-1' });
    });

    it('returns human_review_required, never promotes, and never creates a draft when enforcement is enabled for a requiresHumanReview=true suggestion', async () => {
      (appConfig.editorial as any).humanReviewEnforcementEnabled = true;
      const createSuggestion = vi.fn().mockResolvedValue({ createdSuggestion: true, suggestion: reviewRequiredSuggestion });
      const createDraft = vi.fn();
      const { service, updateSuggestion } = buildService({ createSuggestion, createDraft });

      const result = await service.createDraftFromCandidate({ sourceItemId: 'src_1' }, AGENT_USER_ID);

      expect(result.status).toBe('human_review_required');
      expect(result).toMatchObject({ status: 'human_review_required', suggestionId: 'sug_1' });
      if (result.status === 'human_review_required') {
        expect(result.reasons).toContain('MISSING_REQUIRED_OFFICIAL_SOURCE');
      }
      expect(updateSuggestion).not.toHaveBeenCalled();
      expect(createDraft).not.toHaveBeenCalled();
    });

    it('still promotes and creates a draft when enforcement is enabled but the suggestion does not require human review', async () => {
      (appConfig.editorial as any).humanReviewEnforcementEnabled = true;
      const safeSuggestion = {
        id: 'sug_2',
        priority: 'LOW',
        title: 'Routine update',
        requiresHumanReview: false,
        category: 'Compliance Guides',
        requiresOfficialSource: false,
        sourceQuality: 'OFFICIAL',
        jurisdiction: 'KE',
      };
      const createSuggestion = vi.fn().mockResolvedValue({ createdSuggestion: true, suggestion: safeSuggestion });
      const createDraft = vi.fn().mockResolvedValue({ blogPostId: 'post_2', slug: 'post-2' });
      const { service, updateSuggestion } = buildService({ createSuggestion, createDraft });

      const result = await service.createDraftFromCandidate({ sourceItemId: 'src_2' }, AGENT_USER_ID);

      expect(updateSuggestion).toHaveBeenCalled();
      expect(createDraft).toHaveBeenCalled();
      expect(result).toEqual({ status: 'created', suggestionId: 'sug_2', blogPostId: 'post_2', slug: 'post-2' });
    });
  });
});

describe('AutomationBlogDraftService.generateDraftContent', () => {
  const INPUT = { blogPostId: 'post_1', idempotencyKey: 'idem_generate_1' };

  it('throws FORBIDDEN and never calls generateDraft when beginRun reports agents disabled', async () => {
    const beginRun = vi.fn().mockResolvedValue({ started: false, reason: 'agents_disabled' });
    const generateDraft = vi.fn();
    const { service } = buildService({ agentRuns: { beginRun, completeRun: vi.fn(), failRun: vi.fn() }, generateDraft });

    await expect(service.generateDraftContent(INPUT, AGENT_USER_ID)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(generateDraft).not.toHaveBeenCalled();
  });

  it('throws TOO_MANY_REQUESTS when a fresh run is halted on budget', async () => {
    const beginRun = vi.fn().mockResolvedValue({ started: true, duplicate: false, run: fakeAgentRun({ status: 'HALTED_BUDGET' }) });
    const generateDraft = vi.fn();
    const { service } = buildService({ agentRuns: { beginRun, completeRun: vi.fn(), failRun: vi.fn() }, generateDraft });

    await expect(service.generateDraftContent(INPUT, AGENT_USER_ID)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(generateDraft).not.toHaveBeenCalled();
  });

  it('calls generateDraft with only (blogPostId, agentUserId) - no per-monitor notifyUserId lookup', async () => {
    const beginRun = vi.fn().mockResolvedValue({ started: true, duplicate: false, run: fakeAgentRun() });
    const completeRun = vi.fn().mockResolvedValue({});
    const generateDraft = vi.fn().mockResolvedValue({
      post: { id: 'post_1', title: 'New CBK Circular' },
      runId: 'gen_run_1',
      reviewerNotes: 'looks fine',
      uncertaintyFlags: [],
    });
    const { service } = buildService({ agentRuns: { beginRun, completeRun, failRun: vi.fn() }, generateDraft });

    await service.generateDraftContent(INPUT, AGENT_USER_ID);

    expect(generateDraft).toHaveBeenCalledWith('post_1', AGENT_USER_ID);
  });

  it('persists a content ops alert after a successful generation, including uncertainty flag count', async () => {
    const beginRun = vi.fn().mockResolvedValue({ started: true, duplicate: false, run: fakeAgentRun() });
    const completeRun = vi.fn().mockResolvedValue({});
    const generateDraft = vi.fn().mockResolvedValue({
      post: { id: 'post_1', title: 'New CBK Circular' },
      runId: 'gen_run_1',
      reviewerNotes: 'looks fine',
      uncertaintyFlags: ['unverified date'],
    });
    const { service, createOrIncrementAlert } = buildService({ agentRuns: { beginRun, completeRun, failRun: vi.fn() }, generateDraft });

    await service.generateDraftContent(INPUT, AGENT_USER_ID);

    expect(createOrIncrementAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'draft_ready_for_verification',
        severity: 'HIGH',
        entityType: 'BlogPost',
        entityId: 'post_1',
        title: 'Blog Draft Ready for Verification',
        metadata: expect.objectContaining({ generationRunId: 'gen_run_1', uncertaintyFlagCount: 1 }),
      }),
    );
  });

  it('does not persist a content ops alert when generateDraft fails', async () => {
    const beginRun = vi.fn().mockResolvedValue({ started: true, duplicate: false, run: fakeAgentRun({ id: 'run_42' }) });
    const generateDraft = vi.fn().mockRejectedValue(new Error('boom'));
    const { service, createOrIncrementAlert } = buildService({ agentRuns: { beginRun, completeRun: vi.fn(), failRun: vi.fn() }, generateDraft });

    await expect(service.generateDraftContent(INPUT, AGENT_USER_ID)).rejects.toBeDefined();
    expect(createOrIncrementAlert).not.toHaveBeenCalled();
  });

  it('does not persist a content ops alert on a duplicate replay (avoids re-alerting on retries)', async () => {
    const duplicateRun = fakeAgentRun({
      status: 'COMPLETED',
      metadata: { blogPostId: 'post_1', generationRunId: 'gen_run_1', reviewerNotes: 'looks fine', uncertaintyFlags: [] },
    });
    const beginRun = vi.fn().mockResolvedValue({ started: true, duplicate: true, run: duplicateRun });
    const { service, createOrIncrementAlert } = buildService({ agentRuns: { beginRun, completeRun: vi.fn(), failRun: vi.fn() } });

    await service.generateDraftContent(INPUT, AGENT_USER_ID);

    expect(createOrIncrementAlert).not.toHaveBeenCalled();
  });

  it('completes the run with the generated result stashed in metadata and returns it', async () => {
    const beginRun = vi.fn().mockResolvedValue({ started: true, duplicate: false, run: fakeAgentRun({ id: 'run_42' }) });
    const completeRun = vi.fn().mockResolvedValue({});
    const generateDraft = vi.fn().mockResolvedValue({
      post: { id: 'post_1', title: 'New CBK Circular' },
      runId: 'gen_run_1',
      reviewerNotes: 'looks fine',
      uncertaintyFlags: ['unverified date'],
    });
    const { service } = buildService({ agentRuns: { beginRun, completeRun, failRun: vi.fn() }, generateDraft });

    const result = await service.generateDraftContent(INPUT, AGENT_USER_ID);

    expect(completeRun).toHaveBeenCalledWith({
      runId: 'run_42',
      metadata: { blogPostId: 'post_1', generationRunId: 'gen_run_1', reviewerNotes: 'looks fine', uncertaintyFlags: ['unverified date'] },
    });
    expect(result).toEqual({
      blogPostId: 'post_1',
      generationRunId: 'gen_run_1',
      reviewerNotes: 'looks fine',
      uncertaintyFlags: ['unverified date'],
    });
  });

  it('calls failRun and throws a generic INTERNAL_SERVER_ERROR (not the raw error message) when generateDraft throws', async () => {
    const beginRun = vi.fn().mockResolvedValue({ started: true, duplicate: false, run: fakeAgentRun({ id: 'run_42' }) });
    const failRun = vi.fn().mockResolvedValue({});
    const generateDraft = vi.fn().mockRejectedValue(new Error('AI generation failed: bad JSON'));
    const { service } = buildService({ agentRuns: { beginRun, completeRun: vi.fn(), failRun }, generateDraft });

    await expect(service.generateDraftContent(INPUT, AGENT_USER_ID)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Automation blog draft generation failed.',
    });
    expect(failRun).toHaveBeenCalledWith({
      runId: 'run_42',
      error: 'AI generation failed: bad JSON',
      metadata: { blogPostId: 'post_1' },
    });
  });

  it('replays a completed duplicate run from its stashed metadata without calling generateDraft again', async () => {
    const duplicateRun = fakeAgentRun({
      status: 'COMPLETED',
      metadata: { blogPostId: 'post_1', generationRunId: 'gen_run_1', reviewerNotes: 'looks fine', uncertaintyFlags: [] },
    });
    const beginRun = vi.fn().mockResolvedValue({ started: true, duplicate: true, run: duplicateRun });
    const generateDraft = vi.fn();
    const { service } = buildService({ agentRuns: { beginRun, completeRun: vi.fn(), failRun: vi.fn() }, generateDraft });

    const result = await service.generateDraftContent(INPUT, AGENT_USER_ID);

    expect(generateDraft).not.toHaveBeenCalled();
    expect(result).toEqual({ blogPostId: 'post_1', generationRunId: 'gen_run_1', reviewerNotes: 'looks fine', uncertaintyFlags: [] });
  });

  it('throws CONFLICT for a duplicate run that is not COMPLETED', async () => {
    const duplicateRun = fakeAgentRun({ status: 'RUNNING' });
    const beginRun = vi.fn().mockResolvedValue({ started: true, duplicate: true, run: duplicateRun });
    const { service } = buildService({ agentRuns: { beginRun, completeRun: vi.fn(), failRun: vi.fn() } });

    await expect(service.generateDraftContent(INPUT, AGENT_USER_ID)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('throws INTERNAL_SERVER_ERROR for a duplicate COMPLETED run whose metadata does not match the expected shape', async () => {
    const duplicateRun = fakeAgentRun({ status: 'COMPLETED', metadata: { unexpected: true } });
    const beginRun = vi.fn().mockResolvedValue({ started: true, duplicate: true, run: duplicateRun });
    const { service } = buildService({ agentRuns: { beginRun, completeRun: vi.fn(), failRun: vi.fn() } });

    await expect(service.generateDraftContent(INPUT, AGENT_USER_ID)).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('throws CONFLICT when a duplicate idempotency key belongs to a different blogPostId', async () => {
    const duplicateRun = fakeAgentRun({
      status: 'COMPLETED',
      metadata: { blogPostId: 'post_2', generationRunId: 'gen_run_1', reviewerNotes: 'looks fine', uncertaintyFlags: [] },
    });
    const beginRun = vi.fn().mockResolvedValue({ started: true, duplicate: true, run: duplicateRun });
    const generateDraft = vi.fn();
    const { service } = buildService({ agentRuns: { beginRun, completeRun: vi.fn(), failRun: vi.fn() }, generateDraft });

    await expect(service.generateDraftContent(INPUT, AGENT_USER_ID)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Idempotency key was already used for a different blog post.',
    });
    expect(generateDraft).not.toHaveBeenCalled();
  });

  it('throws INTERNAL_SERVER_ERROR when a completed duplicate has non-string uncertainty flags', async () => {
    const duplicateRun = fakeAgentRun({
      status: 'COMPLETED',
      metadata: { blogPostId: 'post_1', generationRunId: 'gen_run_1', reviewerNotes: 'looks fine', uncertaintyFlags: [123] },
    });
    const beginRun = vi.fn().mockResolvedValue({ started: true, duplicate: true, run: duplicateRun });
    const { service } = buildService({ agentRuns: { beginRun, completeRun: vi.fn(), failRun: vi.fn() } });

    await expect(service.generateDraftContent(INPUT, AGENT_USER_ID)).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });
});
