import { TRPCError } from '@trpc/server';
import { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { appConfig } from '@/config/app.config';
import { logger } from '@/utils/logger';
import { signApprovalCallback } from './approval-callback-signature';

type FetchLike = typeof fetch;

const CALLBACK_TIMEOUT_MS = 5000;
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export type ApprovalDecision = 'approved' | 'rejected';
export type ApprovalStatus = 'pending' | ApprovalDecision | 'expired';

export interface CreateApprovalInput {
  department: string;
  workflow: string;
  kind: string;
  summary: string;
  callbackUrl: string;
  metadata: Record<string, unknown>;
  idempotencyKey: string;
}

export interface RecordApprovalDecisionInput {
  approvalId: string;
  decision: ApprovalDecision;
  by: string;
}

export interface ListApprovalsInput {
  page: number;
  limit: number;
  department?: string;
  workflow?: string;
  status?: ApprovalStatus;
}

export interface ApprovalListRow {
  id: string;
  department: string;
  workflow: string;
  kind: string;
  summary: string;
  metadata: Record<string, unknown> | null;
  status: ApprovalStatus;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  callbackError: string | null;
  callbackDeliveredAt: string | null;
}

export interface ListApprovalsResult {
  rows: ApprovalListRow[];
  total: number;
  page: number;
  limit: number;
}

type ApprovalPrisma = Pick<typeof defaultPrisma, 'automationApproval'>;

export interface AutomationApprovalServiceDependencies {
  prisma?: ApprovalPrisma;
  fetchImpl?: FetchLike;
  now?: () => Date;
  hmacSecret?: string;
}

function toJsonInput(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export class AutomationApprovalService {
  private readonly prisma: ApprovalPrisma;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly hmacSecret: string;

  constructor(dependencies: AutomationApprovalServiceDependencies = {}) {
    this.prisma = dependencies.prisma ?? (defaultPrisma as unknown as ApprovalPrisma);
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.now = dependencies.now ?? (() => new Date());
    this.hmacSecret = dependencies.hmacSecret ?? appConfig.agents.automation.hmacSecret;
  }

  /**
   * Insert-then-catch-conflict, not find-then-create: a find-then-create
   * check has a TOCTOU race under concurrent duplicate calls (two simultaneous
   * retries can both pass the find before either insert lands). The unique
   * index on idempotencyKey is the actual dedup guarantee; the P2002 catch
   * just turns that DB-level rejection into an idempotent replay response.
   */
  async createApproval(input: CreateApprovalInput): Promise<{ approvalId: string }> {
    try {
      const approval = await this.prisma.automationApproval.create({
        data: {
          department: input.department,
          workflow: input.workflow,
          kind: input.kind,
          summary: input.summary,
          callbackUrl: input.callbackUrl,
          metadata: toJsonInput(input.metadata),
          idempotencyKey: input.idempotencyKey,
          expiresAt: new Date(this.now().getTime() + APPROVAL_TTL_MS),
        },
        select: { id: true },
      });

      logger.info({ type: 'automation_approval_created', approvalId: approval.id, department: input.department, workflow: input.workflow, kind: input.kind });
      return { approvalId: approval.id };
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        const existing = await this.prisma.automationApproval.findUniqueOrThrow({
          where: { idempotencyKey: input.idempotencyKey },
          select: { id: true },
        });

        logger.info({ type: 'automation_approval_idempotent_replay', approvalId: existing.id, idempotencyKey: input.idempotencyKey });
        return { approvalId: existing.id };
      }
      throw error;
    }
  }

  /**
   * Backs the admin approvals page. Most-recent-first; department/workflow/
   * status are optional equality filters (not full-text search - the page
   * groups/filters by exact values, per the admin-UI request).
   */
  async listApprovals(input: ListApprovalsInput): Promise<ListApprovalsResult> {
    const where = {
      ...(input.department ? { department: input.department } : {}),
      ...(input.workflow ? { workflow: input.workflow } : {}),
      ...(input.status ? { status: input.status } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.automationApproval.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (input.page - 1) * input.limit,
        take: input.limit,
      }),
      this.prisma.automationApproval.count({ where }),
    ]);

    return {
      rows: rows.map((row) => ({
        id: row.id,
        department: row.department,
        workflow: row.workflow,
        kind: row.kind,
        summary: row.summary,
        metadata: (row.metadata as Record<string, unknown> | null) ?? null,
        status: row.status as ApprovalStatus,
        createdAt: row.createdAt.toISOString(),
        decidedBy: row.decidedBy,
        decidedAt: row.decidedAt?.toISOString() ?? null,
        callbackError: row.callbackError,
        callbackDeliveredAt: row.callbackDeliveredAt?.toISOString() ?? null,
      })),
      total,
      page: input.page,
      limit: input.limit,
    };
  }

  async getApproval(input: { approvalId: string }): Promise<{ status: ApprovalStatus }> {
    const approval = await this.prisma.automationApproval.findUnique({
      where: { id: input.approvalId },
      select: { status: true },
    });

    if (!approval) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Approval not found.' });
    }

    return { status: approval.status as ApprovalStatus };
  }

  /**
   * Reads one field out of an approval's metadata JSON - shared by every
   * "approval gates a pre-existing backend row" consumer (publishContent's
   * blogPostId, queueOutreach's draftId) so the same missing-field error and
   * type-narrowing logic isn't duplicated per consumer.
   */
  async requireMetadataField(approvalId: string, field: string): Promise<string> {
    const row = await this.prisma.automationApproval.findUnique({
      where: { id: approvalId },
      select: { metadata: true },
    });

    const metadata = row?.metadata;
    const value = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>)[field] : undefined;

    if (typeof value !== 'string' || value.length === 0) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Approval ${approvalId}'s metadata is missing required field "${field}" - createApproval must set this when the approval is created.`,
      });
    }
    return value;
  }

  /**
   * `by` is the deciding admin's own user ID, derived server-side by the
   * caller (agentsRouter.automation.recordApprovalDecision runs as
   * adminProcedure, not agentProcedure - this is a human decision, not an
   * n8n-triggered one) - never accept it as raw client input.
   */
  async recordApprovalDecision(input: RecordApprovalDecisionInput): Promise<{ approvalId: string; status: ApprovalStatus }> {
    const decidedAt = this.now();

    const preCheck = await this.prisma.automationApproval.findUnique({
      where: { id: input.approvalId },
      select: { status: true, expiresAt: true },
    });
    if (!preCheck) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Approval not found.' });
    }

    // expiresAt is null-guarded: legacy rows created before this column
    // existed never expire. A racing decision/sweep between this check and
    // the updateMany below is caught by that call's own `status: 'pending'`
    // filter, which falls through to the CONFLICT branch - it never clobbers
    // a decision (or an expiry) that landed in the meantime.
    if (preCheck.status === 'pending' && preCheck.expiresAt && preCheck.expiresAt < decidedAt) {
      await this.prisma.automationApproval.updateMany({
        where: { id: input.approvalId, status: 'pending' },
        data: { status: 'expired' },
      });
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Approval ${input.approvalId} expired at ${preCheck.expiresAt.toISOString()}.`,
      });
    }

    const updateResult = await this.prisma.automationApproval.updateMany({
      where: { id: input.approvalId, status: 'pending' },
      data: { status: input.decision, decidedBy: input.by, decidedAt },
    });

    if (updateResult.count === 0) {
      const existing = await this.prisma.automationApproval.findUnique({
        where: { id: input.approvalId },
        select: { status: true },
      });
      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Approval not found.' });
      }
      throw new TRPCError({ code: 'CONFLICT', message: `Approval already decided (status: ${existing.status}).` });
    }

    const approval = await this.prisma.automationApproval.findUniqueOrThrow({
      where: { id: input.approvalId },
      select: { callbackUrl: true },
    });

    await this.deliverCallback(input.approvalId, input.decision, approval.callbackUrl);

    logger.info({ type: 'automation_approval_decided', approvalId: input.approvalId, decision: input.decision, by: input.by });
    return { approvalId: input.approvalId, status: input.decision };
  }

  /**
   * Best-effort: never throws. n8n's own 30-minute-timeout polling fallback
   * (getApproval) is the recovery path if this delivery fails, so the
   * decision itself must persist regardless of the callback's outcome.
   */
  private async deliverCallback(approvalId: string, decision: ApprovalDecision, callbackUrl: string): Promise<void> {
    const timestampSeconds = Math.floor(this.now().getTime() / 1000);
    const signature = signApprovalCallback(this.hmacSecret, { approvalId, decision, timestampSeconds });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);

    try {
      const response = await this.fetchImpl(callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-sheriabot-timestamp': String(timestampSeconds),
          'x-sheriabot-signature': signature,
        },
        body: JSON.stringify({ approvalId, decision, timestamp: timestampSeconds }),
        signal: controller.signal,
      });

      if (!response.ok) {
        await this.recordCallbackFailure(approvalId, `http_${response.status}`);
        return;
      }

      await this.prisma.automationApproval.update({
        where: { id: approvalId },
        data: { callbackDeliveredAt: this.now(), callbackError: null },
      });
    } catch (error: unknown) {
      await this.recordCallbackFailure(approvalId, error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeout);
    }
  }

  private async recordCallbackFailure(approvalId: string, reason: string): Promise<void> {
    logger.warn({ type: 'automation_approval_callback_failed', approvalId, reason });
    await this.prisma.automationApproval.update({
      where: { id: approvalId },
      data: { callbackError: reason },
    });
  }

  /**
   * Swept counterpart to recordApprovalDecision's defensive expiry check -
   * ages out PENDING rows nobody ever decided on. Legacy rows with a null
   * expiresAt are excluded by the `lt` filter itself (never matches null),
   * so they're left PENDING indefinitely, same as before this column existed.
   */
  async expireStalePendingApprovals(): Promise<number> {
    const result = await this.prisma.automationApproval.updateMany({
      where: { status: 'pending', expiresAt: { lt: this.now() } },
      data: { status: 'expired' },
    });

    logger.info({ type: 'automation_approval_expired_batch', count: result.count });
    return result.count;
  }
}

export const automationApprovalService = new AutomationApprovalService();
