import { z } from 'zod';
import { router, agentProcedure, adminProcedure } from '../trpc/trpc';
import { rateLimited } from '../trpc/middleware';
import { agentRunService } from '@/modules/agents/agent-run.service';
import { regulatoryIntelligenceAgent } from '@/modules/agents/regulatory-intelligence/reg-intel.agent';
import { marketingAgent } from '@/modules/agents/marketing/marketing.agent';
import { MARKETING_CONTENT_TYPES, MARKETING_DRAFT_STATUSES } from '@/modules/agents/marketing/types';
import { salesGrowthAgent } from '@/modules/agents/sales/sales-growth.agent';
import { SALES_DRAFT_STATUSES } from '@/modules/agents/sales/types';
import { automationService } from '@/modules/agents/automation/automation.service';
import { appConfig } from '@/config/app.config';

type JsonInputValue = string | number | boolean | JsonInputValue[] | { [key: string]: JsonInputValue };

const jsonValueSchema: z.ZodType<JsonInputValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ])
);

const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

const agentRunIdSchema = z.object({ runId: z.string().min(1) });

const tokenCostSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  metadata: jsonObjectSchema.optional(),
});

const AUTOMATION_PAYLOAD_MAX_BYTES = 16 * 1024;

const automationPayloadSchema = jsonObjectSchema.refine(
  (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= AUTOMATION_PAYLOAD_MAX_BYTES,
  { message: `payload exceeds ${AUTOMATION_PAYLOAD_MAX_BYTES} byte limit` },
);

export const agentsRouter = router({
  beginRun: agentProcedure('agents.run.create')
    .input(z.object({
      agentType: z.string().min(1).max(100),
      idempotencyKey: z.string().min(8).max(200),
      organizationId: z.string().min(1).optional(),
      metadata: jsonObjectSchema.optional(),
      estimatedCostUsd: z.number().nonnegative().optional(),
    }))
    .mutation(async ({ input }) => agentRunService.beginRun(input)),

  getRun: agentProcedure('agents.run.read')
    .input(agentRunIdSchema)
    .query(async ({ input }) => agentRunService.getRun(input.runId)),

  advanceRun: agentProcedure('agents.run.advance')
    .input(agentRunIdSchema.merge(tokenCostSchema))
    .mutation(async ({ input }) => agentRunService.advanceRun(input)),

  completeRun: agentProcedure('agents.run.complete')
    .input(agentRunIdSchema.merge(tokenCostSchema))
    .mutation(async ({ input }) => agentRunService.completeRun(input)),

  failRun: agentProcedure('agents.run.fail')
    .input(z.object({
      runId: z.string().min(1),
      error: z.string().min(1).max(2000),
      metadata: jsonObjectSchema.optional(),
    }))
    .mutation(async ({ input }) => agentRunService.failRun(input)),

  createReport: agentProcedure('agents.report.create')
    .input(z.object({
      agentRunId: z.string().min(1),
      summary: z.string().max(5000).optional(),
      signals: jsonObjectSchema.optional(),
      recommendedActions: jsonObjectSchema.optional(),
      risks: jsonObjectSchema.optional(),
      humanApproved: z.boolean().optional(),
    }))
    .mutation(async ({ input }) => agentRunService.createReport(input)),
  marketing: router({
    runDrafting: agentProcedure('agents.marketing.draft.create')
      .input(z.object({
        idempotencyKey: z.string().min(8).max(200).optional(),
        maxSignals: z.number().int().positive().max(50).optional(),
      }).optional())
      .mutation(async ({ input }) => marketingAgent.runDrafting(input ?? {})),

    listDrafts: agentProcedure('agents.marketing.draft.read')
      .input(z.object({
        page: z.number().int().positive().default(1),
        limit: z.number().int().positive().max(100).default(20),
        status: z.enum(MARKETING_DRAFT_STATUSES).optional(),
        contentType: z.enum(MARKETING_CONTENT_TYPES).optional(),
      }))
      .query(async ({ input }) => marketingAgent.listDrafts(input)),

    getDraft: agentProcedure('agents.marketing.draft.read')
      .input(z.object({ draftId: z.string().min(1) }))
      .query(async ({ input }) => marketingAgent.getDraft(input.draftId)),

    reviewDraft: adminProcedure
      .input(z.object({
        draftId: z.string().min(1),
        status: z.enum(['REVIEWED', 'DISMISSED']),
        editedBody: z.string().max(10000).optional(),
      }))
      .mutation(async ({ input, ctx }) => marketingAgent.reviewDraft({
        draftId: input.draftId,
        status: input.status,
        editedBody: input.editedBody,
        reviewedBy: ctx.user!.id,
      })),
  }),
  regIntel: router({
    runScan: agentProcedure('agents.run.create')
      .input(z.object({
        idempotencyKey: z.string().min(8).max(200).optional(),
        maxItems: z.number().int().positive().max(100).optional(),
      }).optional())
      .mutation(async ({ input }) => regulatoryIntelligenceAgent.runScan(input ?? {})),

    getLatestReport: agentProcedure('agents.run.read')
      .query(async () => regulatoryIntelligenceAgent.getLatestReport()),

    listSignals: agentProcedure('agents.run.read')
      .input(z.object({
        page: z.number().int().positive().default(1),
        limit: z.number().int().positive().max(100).default(20),
        jurisdiction: z.string().min(1).optional(),
        severity: z.string().min(1).optional(),
        corpusGap: z.boolean().optional(),
        status: z.string().min(1).optional(),
      }))
      .query(async ({ input }) => regulatoryIntelligenceAgent.listSignals(input)),

    acknowledgeSignal: agentProcedure('agents.run.advance')
      .input(z.object({ signalId: z.string().min(1) }))
      .mutation(async ({ input }) => regulatoryIntelligenceAgent.acknowledgeSignal(input.signalId)),
  }),
  sales: router({
    runDrafting: agentProcedure('agents.sales.draft.create')
      .input(z.object({
        idempotencyKey: z.string().min(8).max(200).optional(),
        maxProspects: z.number().int().positive().max(50).optional(),
      }).optional())
      .mutation(async ({ input }) => salesGrowthAgent.runDrafting(input ?? {})),

    listDrafts: agentProcedure('agents.sales.draft.read')
      .input(z.object({
        page: z.number().int().positive().default(1),
        limit: z.number().int().positive().max(100).default(20),
        status: z.enum(SALES_DRAFT_STATUSES).optional(),
      }))
      .query(async ({ input }) => salesGrowthAgent.listDrafts(input)),

    getDraft: agentProcedure('agents.sales.draft.read')
      .input(z.object({ draftId: z.string().min(1) }))
      .query(async ({ input }) => salesGrowthAgent.getDraft(input.draftId)),

    reviewDraft: adminProcedure
      .input(z.object({
        draftId: z.string().min(1),
        status: z.enum(['REVIEWED', 'DISMISSED']),
        editedBody: z.string().max(10000).optional(),
      }))
      .mutation(async ({ input, ctx }) => salesGrowthAgent.reviewDraft({
        draftId: input.draftId,
        status: input.status,
        editedBody: input.editedBody,
        reviewedBy: ctx.user!.id,
      })),
  }),
  automation: router({
    // Called by the n8n automation instance (agents.sheriabot.com), authenticated
    // as the sys-automation-orchestrator principal  -  scoped to exactly these
    // two capabilities, nothing broader. See agent-credential.service.ts.
    logEvent: agentProcedure('agents.automation.log.create')
      .use(rateLimited('automation-log', appConfig.agents.automation.logRateLimitMax, {
        window: appConfig.agents.automation.logRateLimitWindowSeconds,
      }))
      .input(z.object({
        workflowKey: z.string().min(1).max(100),
        event: z.string().min(1).max(100),
        payload: automationPayloadSchema,
        executionId: z.string().min(1).max(200),
      }))
      .mutation(async ({ input }) => automationService.logEvent(input)),

    generate: agentProcedure('agents.automation.generate')
      .use(rateLimited('automation-generate', appConfig.agents.automation.generateRateLimitMax, {
        window: appConfig.agents.automation.generateRateLimitWindowSeconds,
      }))
      .input(z.object({
        workflowKey: z.string().min(1).max(100),
        taskType: z.string().min(1).max(100),
        systemPrompt: z.string().min(1).max(4000),
        userPrompt: z.string().min(1).max(20000),
        maxTokens: z.number().int().positive().max(4000),
      }))
      .mutation(async ({ input }) => automationService.generate(input)),
  }),
});
