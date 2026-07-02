import { z } from 'zod';
import { router, agentProcedure } from '../trpc/trpc';
import { agentRunService } from '@/modules/agents/agent-run.service';
import { regulatoryIntelligenceAgent } from '@/modules/agents/regulatory-intelligence/reg-intel.agent';

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
});
