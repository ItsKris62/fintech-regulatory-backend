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
import { automationMetricsService } from '@/modules/agents/automation/metrics.service';
import { automationApprovalService } from '@/modules/agents/automation/approval.service';
import { automationContentService } from '@/modules/agents/automation/content.service';
import { automationSourcesService } from '@/modules/agents/automation/sources.service';
import { automationPilotVendorService } from '@/modules/agents/automation/pilot-vendor.service';
import { automationOutreachService } from '@/modules/agents/automation/outreach.service';
import { automationNewsletterService } from '@/modules/agents/automation/newsletter.service';
import { appConfig } from '@/config/app.config';
import { productBiAgent } from '@/modules/agents/product-bi/product-bi.agent';
import { securityOpsAgent } from '@/modules/agents/security-ops/security-ops.agent';
import { chiefOfStaffAgent } from '@/modules/agents/chief-of-staff/chief-of-staff.agent';

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
    // Callable only by sys-scheduler-orchestrator (n8n trigger surface, Tue/Fri
    // per docs/sprints/b9-n8n-trigger-wiring-stage1-audit.md). sys-agent-orchestrator
    // does NOT hold this capability - trigger capabilities are disjoint from its
    // grant, same pattern as AUTOMATION_CAPABILITIES.
    runDrafting: agentProcedure('agents.marketing.draft.create')
      .use(rateLimited('agent-trigger-marketing-runDrafting', appConfig.agents.trigger.rateLimitMax, {
        window: appConfig.agents.trigger.rateLimitWindowSeconds,
      }))
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
    // Callable only by sys-scheduler-orchestrator (n8n trigger surface, daily
    // per docs/sprints/b9-n8n-trigger-wiring-stage1-audit.md). sys-agent-orchestrator
    // does NOT hold this capability - trigger capabilities are disjoint from its
    // grant, same pattern as AUTOMATION_CAPABILITIES. Deliberately its own
    // dedicated capability, not the shared agents.run.create the generic
    // beginRun mutation uses  -  see that audit's Section 2.
    runScan: agentProcedure('agents.regIntel.run.create')
      .use(rateLimited('agent-trigger-regIntel-runScan', appConfig.agents.trigger.rateLimitMax, {
        window: appConfig.agents.trigger.rateLimitWindowSeconds,
      }))
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
    // Callable only by sys-scheduler-orchestrator (n8n trigger surface, Tue/Fri
    // per docs/sprints/b9-n8n-trigger-wiring-stage1-audit.md). sys-agent-orchestrator
    // does NOT hold this capability - trigger capabilities are disjoint from its
    // grant, same pattern as AUTOMATION_CAPABILITIES.
    runDrafting: agentProcedure('agents.sales.draft.create')
      .use(rateLimited('agent-trigger-sales-runDrafting', appConfig.agents.trigger.rateLimitMax, {
        window: appConfig.agents.trigger.rateLimitWindowSeconds,
      }))
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

    // department-specific metrics for the n8n automation surface (Daily
    // Product Pulse, Monday Board Brief, Conversion Signal Scan, Sentry
    // Watcher, Uptime & Budget Watch). Only 'product' | 'sales' | 'security'
    // are implemented today - see metrics-types.ts SUPPORTED_METRICS_DEPARTMENTS.
    getMetrics: agentProcedure('agents.automation.metrics.read')
      .use(rateLimited('automation-metrics', appConfig.agents.automation.metricsRateLimitMax, {
        window: appConfig.agents.automation.metricsRateLimitWindowSeconds,
      }))
      .input(z.object({
        department: z.string().min(1).max(50),
        window: z.string().min(1).max(20),
        jurisdictions: z.string().max(500).optional(),
        detail: z.string().max(50).optional(),
      }))
      .mutation(async ({ input }) => automationMetricsService.getMetrics(input)),

    // Approval trio - backend-owned gate for customer-facing n8n workflows
    // (content publish/newsletter/LinkedIn/sales outreach). createApproval and
    // getApproval are called by n8n (agentProcedure, sys-automation-orchestrator).
    // recordApprovalDecision is NOT - it's the human (founder) decision, so it
    // runs as adminProcedure and derives `by` from the session, the same
    // pattern as marketing.reviewDraft/sales.reviewDraft above - never a
    // client-supplied identity string.
    createApproval: agentProcedure('agents.automation.approval.create')
      .use(rateLimited('automation-approval-create', appConfig.agents.automation.approvalCreateRateLimitMax, {
        window: appConfig.agents.automation.approvalCreateRateLimitWindowSeconds,
      }))
      .input(z.object({
        department: z.string().min(1).max(100),
        workflow: z.string().min(1).max(100),
        kind: z.string().min(1).max(100),
        summary: z.string().min(1).max(5000),
        callbackUrl: z.string().url().max(2000),
        metadata: jsonObjectSchema,
      }))
      .mutation(async ({ input }) => automationApprovalService.createApproval(input)),

    getApproval: agentProcedure('agents.automation.approval.read')
      .use(rateLimited('automation-approval-read', appConfig.agents.automation.approvalReadRateLimitMax, {
        window: appConfig.agents.automation.approvalReadRateLimitWindowSeconds,
      }))
      .input(z.object({ approvalId: z.string().min(1) }))
      .mutation(async ({ input }) => automationApprovalService.getApproval(input)),

    recordApprovalDecision: adminProcedure
      .input(z.object({
        approvalId: z.string().min(1),
        decision: z.enum(['approved', 'rejected']),
      }))
      .mutation(async ({ input, ctx }) => automationApprovalService.recordApprovalDecision({
        approvalId: input.approvalId,
        decision: input.decision,
        by: ctx.user!.id,
      })),

    // Backs the admin approvals dashboard (not n8n-facing, same as
    // recordApprovalDecision above) - a plain read, so adminProcedure +
    // .query(), unlike every agentProcedure automation.* mutation above
    // (those are POST-only to match n8n's calling convention; this is
    // browser-called via the normal tRPC client, which handles queries fine).
    listApprovals: adminProcedure
      .input(z.object({
        page: z.number().int().positive().default(1),
        limit: z.number().int().positive().max(100).default(20),
        department: z.string().min(1).max(100).optional(),
        workflow: z.string().min(1).max(100).optional(),
        status: z.enum(['pending', 'approved', 'rejected']).optional(),
      }))
      .query(async ({ input }) => automationApprovalService.listApprovals(input)),

    // Phase 3 - single-workflow procedures, no shared dependencies between
    // them. All share one rate-limit bucket (appConfig.agents.automation.
    // workflow*) - same precedent as appConfig.agents.trigger (B9): these are
    // once-per-workflow-run calls with no reason for distinct ceilings.
    publishContent: agentProcedure('agents.automation.content.publish')
      .use(rateLimited('automation-publish-content', appConfig.agents.automation.workflowRateLimitMax, {
        window: appConfig.agents.automation.workflowRateLimitWindowSeconds,
      }))
      .input(z.object({ approvalId: z.string().min(1), content: z.string().min(1) }))
      .mutation(async ({ input }) => automationContentService.publishContent(input)),

    queueContentCandidate: agentProcedure('agents.automation.content.queueCandidate')
      .use(rateLimited('automation-queue-content-candidate', appConfig.agents.automation.workflowRateLimitMax, {
        window: appConfig.agents.automation.workflowRateLimitWindowSeconds,
      }))
      .input(z.object({
        sourceItemId: z.string().min(1),
        title: z.string().min(1).max(500),
        score: z.number(),
        jurisdiction: z.string().min(1),
      }))
      .mutation(async ({ input }) => automationContentService.queueContentCandidate(input)),

    getRecentHighImpactRegulatoryItems: agentProcedure('agents.automation.regulatoryItems.read')
      .use(rateLimited('automation-recent-high-impact-items', appConfig.agents.automation.workflowRateLimitMax, {
        window: appConfig.agents.automation.workflowRateLimitWindowSeconds,
      }))
      .input(z.object({ window: z.string().min(1).max(20), jurisdictions: z.string().max(500) }))
      .mutation(async ({ input }) => automationContentService.getRecentHighImpactRegulatoryItems(input)),

    getApprovedContentThisWeek: agentProcedure('agents.automation.approvedContent.read')
      .use(rateLimited('automation-approved-content-this-week', appConfig.agents.automation.workflowRateLimitMax, {
        window: appConfig.agents.automation.workflowRateLimitWindowSeconds,
      }))
      .input(z.object({ jurisdictions: z.string().max(500) }))
      .mutation(async ({ input }) => automationContentService.getApprovedContentThisWeek(input)),

    // NOT wired to a real send - see newsletter.service.ts. Approval gate is
    // real; the send itself throws NOT_IMPLEMENTED with a clear explanation.
    sendNewsletter: agentProcedure('agents.automation.newsletter.send')
      .use(rateLimited('automation-send-newsletter', appConfig.agents.automation.workflowRateLimitMax, {
        window: appConfig.agents.automation.workflowRateLimitWindowSeconds,
      }))
      .input(z.object({ approvalId: z.string().min(1), html: z.string().min(1) }))
      .mutation(async ({ input }) => automationNewsletterService.sendNewsletter(input)),

    queueOutreach: agentProcedure('agents.automation.outreach.queue')
      .use(rateLimited('automation-queue-outreach', appConfig.agents.automation.workflowRateLimitMax, {
        window: appConfig.agents.automation.workflowRateLimitWindowSeconds,
      }))
      .input(z.object({ approvalId: z.string().min(1), orgId: z.string().min(1), content: z.string().min(1) }))
      .mutation(async ({ input }) => automationOutreachService.queueOutreach(input)),

    getSources: agentProcedure('agents.automation.sources.read')
      .use(rateLimited('automation-get-sources', appConfig.agents.automation.workflowRateLimitMax, {
        window: appConfig.agents.automation.workflowRateLimitWindowSeconds,
      }))
      .input(z.object({ jurisdictions: z.string().max(500) }))
      .mutation(async ({ input }) => automationSourcesService.getSources(input)),

    fetchSource: agentProcedure('agents.automation.sources.fetch')
      .use(rateLimited('automation-fetch-source', appConfig.agents.automation.workflowRateLimitMax, {
        window: appConfig.agents.automation.workflowRateLimitWindowSeconds,
      }))
      .input(z.object({ url: z.string().url(), sourceId: z.string().min(1), jurisdiction: z.string().min(1) }))
      .mutation(async ({ input }) => automationSourcesService.fetchSource(input)),

    dedupeSource: agentProcedure('agents.automation.sources.dedupe')
      .use(rateLimited('automation-dedupe-source', appConfig.agents.automation.workflowRateLimitMax, {
        window: appConfig.agents.automation.workflowRateLimitWindowSeconds,
      }))
      .input(z.object({ contentHash: z.string().min(1), jurisdiction: z.string().min(1) }))
      .mutation(async ({ input }) => automationSourcesService.dedupeSource(input)),

    getPilotCohortStatus: agentProcedure('agents.automation.pilotCohort.read')
      .use(rateLimited('automation-pilot-cohort-status', appConfig.agents.automation.workflowRateLimitMax, {
        window: appConfig.agents.automation.workflowRateLimitWindowSeconds,
      }))
      .input(z.object({ cohort: z.string().min(1), jurisdictions: z.string().max(500) }))
      .mutation(async ({ input }) => automationPilotVendorService.getPilotCohortStatus(input)),

    getDpaVendorStatus: agentProcedure('agents.automation.dpaVendor.read')
      .use(rateLimited('automation-dpa-vendor-status', appConfig.agents.automation.workflowRateLimitMax, {
        window: appConfig.agents.automation.workflowRateLimitWindowSeconds,
      }))
      .mutation(async () => automationPilotVendorService.getDpaVendorStatus()),
  }),
  productBi: router({
    // Read-only synthesis across ALL organizations, not one tenant - deliberately
    // reachable only via agentProcedure, never orgMemberProcedure or any other
    // tenant-scoped procedure. See product-bi.safety.test.ts.
    // Callable only by sys-scheduler-orchestrator (n8n trigger surface, Fri only
    // per docs/sprints/b9-n8n-trigger-wiring-stage1-audit.md). sys-agent-orchestrator
    // does NOT hold this capability - trigger capabilities are disjoint from its
    // grant, same pattern as AUTOMATION_CAPABILITIES.
    runReport: agentProcedure('agents.productBi.report.create')
      .use(rateLimited('agent-trigger-productBi-runReport', appConfig.agents.trigger.rateLimitMax, {
        window: appConfig.agents.trigger.rateLimitWindowSeconds,
      }))
      .input(z.object({
        idempotencyKey: z.string().min(8).max(200).optional(),
        windowDays: z.number().int().positive().max(90).optional(),
      }).optional())
      .mutation(async ({ input }) => productBiAgent.runReport(input ?? {})),

    getLatestReport: agentProcedure('agents.productBi.report.read')
      .query(async () => productBiAgent.getLatestReport()),

    listReports: agentProcedure('agents.productBi.report.read')
      .input(z.object({
        page: z.number().int().positive().default(1),
        limit: z.number().int().positive().max(100).default(20),
      }))
      .query(async ({ input }) => productBiAgent.listReports(input)),
  }),
  securityOps: router({
    // Read-only synthesis across ALL organizations' agent-workforce spend plus
    // process-level service health, not one tenant - deliberately reachable
    // only via agentProcedure. See security-ops.safety.test.ts.
    // Callable only by sys-scheduler-orchestrator (n8n trigger surface, daily
    // per docs/sprints/b9-n8n-trigger-wiring-stage1-audit.md). sys-agent-orchestrator
    // does NOT hold this capability - trigger capabilities are disjoint from its
    // grant, same pattern as AUTOMATION_CAPABILITIES.
    runReport: agentProcedure('agents.securityOps.report.create')
      .use(rateLimited('agent-trigger-securityOps-runReport', appConfig.agents.trigger.rateLimitMax, {
        window: appConfig.agents.trigger.rateLimitWindowSeconds,
      }))
      .input(z.object({
        idempotencyKey: z.string().min(8).max(200).optional(),
        windowDays: z.number().int().positive().max(30).optional(),
      }).optional())
      .mutation(async ({ input }) => securityOpsAgent.runReport(input ?? {})),

    getLatestReport: agentProcedure('agents.securityOps.report.read')
      .query(async () => securityOpsAgent.getLatestReport()),

    listReports: agentProcedure('agents.securityOps.report.read')
      .input(z.object({
        page: z.number().int().positive().default(1),
        limit: z.number().int().positive().max(100).default(20),
      }))
      .query(async ({ input }) => securityOpsAgent.listReports(input)),
  }),
  chiefOfStaff: router({
    // Reads the latest AgentReport from B3-B7 and synthesizes one weekly
    // brief - deliberately reachable only via agentProcedure. See
    // chief-of-staff.safety.test.ts.
    // Callable only by sys-scheduler-orchestrator (n8n trigger surface, Fri
    // only, scheduled last per docs/sprints/b9-n8n-trigger-wiring-stage1-audit.md).
    // sys-agent-orchestrator does NOT hold this capability - trigger
    // capabilities are disjoint from its grant, same pattern as
    // AUTOMATION_CAPABILITIES.
    runBrief: agentProcedure('agents.chiefOfStaff.report.create')
      .use(rateLimited('agent-trigger-chiefOfStaff-runBrief', appConfig.agents.trigger.rateLimitMax, {
        window: appConfig.agents.trigger.rateLimitWindowSeconds,
      }))
      .input(z.object({
        idempotencyKey: z.string().min(8).max(200).optional(),
      }).optional())
      .mutation(async ({ input }) => chiefOfStaffAgent.runBrief(input ?? {})),

    getLatestReport: agentProcedure('agents.chiefOfStaff.report.read')
      .query(async () => chiefOfStaffAgent.getLatestReport()),

    listReports: agentProcedure('agents.chiefOfStaff.report.read')
      .input(z.object({
        page: z.number().int().positive().default(1),
        limit: z.number().int().positive().max(100).default(20),
      }))
      .query(async ({ input }) => chiefOfStaffAgent.listReports(input)),
  }),
});
