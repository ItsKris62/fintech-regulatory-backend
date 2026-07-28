import { randomUUID } from 'node:crypto';
import type { AutomationIncidentSeverity, AutomationIncidentStatus, ContentOpsAlert, ContentOpsAlertNotificationStatus, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { appConfig } from '@/config/app.config';
import { escapeHtml } from '@/utils/html-escape';
import { sendEmail as defaultSendEmail } from '@/lib/email/client';
import type { EmailOptions, EmailResult } from '@/lib/email/client';
import { logger } from '@/utils/logger';
import { sanitizeAlertMetadata, sanitizeAlertText } from './content-ops-alert-sanitizer';

export type SendEmail = (options: EmailOptions) => Promise<EmailResult>;

// 12h cooldown, matching blog-notification.service.ts's verify_blocked-class
// TTL precedent for a high-severity operational event.
const NOTIFICATION_COOLDOWN_MS = 12 * 60 * 60 * 1000;

// Only these severities are ever eligible for an email notification at all -
// "lower-severity alerts may persist without immediate email" (Stage C4).
const NOTIFY_ELIGIBLE_SEVERITIES: readonly AutomationIncidentSeverity[] = ['HIGH', 'CRITICAL'];

type ContentOpsAlertPrisma = {
  $queryRaw<T = unknown>(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]): Promise<T>;
  contentOpsAlert: Pick<typeof defaultPrisma.contentOpsAlert, 'findUnique' | 'findMany' | 'update' | 'count'>;
};

export interface ContentOpsAlertDependencies {
  prisma?: ContentOpsAlertPrisma;
  sendEmail?: SendEmail;
  now?: () => Date;
}

/** Preserved for backward compatibility with any existing caller shape. */
export interface ContentOpsAlertInput {
  subject: string;
  summary: string;
  details?: string[];
  link?: string;
}

export interface CreateOrIncrementAlertInput {
  type: string;
  severity: AutomationIncidentSeverity;
  entityType: string;
  entityId: string;
  title: string;
  summary: string;
  workflowKey?: string;
  executionId?: string;
  metadata?: Record<string, unknown>;
}

export interface AcknowledgeAlertInput {
  alertId: string;
  by: string;
}

export interface ResolveAlertInput {
  alertId: string;
  by: string;
  resolutionNote?: string;
}

export interface ListOpenAlertsInput {
  page?: number;
  limit?: number;
  severity?: AutomationIncidentSeverity;
  type?: string;
  entityType?: string;
}

export interface ListOpenAlertsResult {
  rows: ContentOpsAlert[];
  total: number;
}

export interface MarkNotificationResultInput {
  alertId: string;
  status: Extract<ContentOpsAlertNotificationStatus, 'SENT' | 'FAILED'>;
}

/**
 * Persist-first, notify-second content operations alerting (Pack 1 Stage C4,
 * corrected from the original fire-and-forget email-only design). See
 * docs/editorial-intelligence/phase-b-foundations.md Foundation C.
 *
 * Dedupe/reopen identity is (type, entityType, entityId, COALESCE(workflowKey, ''))
 * - a raw SQL expression unique index (prisma/migrations/20260727020000_content_ops_alert)
 * that Prisma's typed client cannot target directly, so createOrIncrementAlert
 * uses an atomic `$queryRaw` INSERT ... ON CONFLICT ... DO UPDATE, never a
 * vulnerable find-then-create.
 *
 * status (AutomationIncidentStatus.OPEN/ACKNOWLEDGED/RESOLVED/IGNORED) is a
 * human content-review decision. notificationStatus
 * (NOT_REQUIRED/PENDING/SENT/FAILED/SUPPRESSED) is an independent
 * delivery-mechanics decision - never conflate or derive one from the other.
 */
export class ContentOpsAlertService {
  private readonly prisma: ContentOpsAlertPrisma;
  private readonly sendEmail: SendEmail;
  private readonly now: () => Date;

  constructor(dependencies: ContentOpsAlertDependencies = {}) {
    this.prisma = dependencies.prisma ?? (defaultPrisma as unknown as ContentOpsAlertPrisma);
    this.sendEmail = dependencies.sendEmail ?? defaultSendEmail;
    this.now = dependencies.now ?? (() => new Date());
  }

  /**
   * Best-effort email delivery - the one thing this service does that can
   * fail without affecting the persisted alert, since the alert row is always
   * written first, in its own statement, before this is ever attempted.
   */
  private async deliverEmail(input: ContentOpsAlertInput): Promise<boolean> {
    const summaryHtml = escapeHtml(input.summary);
    const detailItems = (input.details ?? []).map((detail) => `<li>${escapeHtml(detail)}</li>`).join('');
    const linkHtml = input.link ? `<p><a href="${input.link}">Review</a></p>` : '';

    try {
      await this.sendEmail({
        to: appConfig.marketing.adminNotificationEmail,
        subject: input.subject,
        html: `<p>${summaryHtml}</p>${detailItems ? `<ul>${detailItems}</ul>` : ''}${linkHtml}`,
        text: `${input.summary}\n\n${(input.details ?? []).join('\n')}${input.link ? `\n\n${input.link}` : ''}`,
        tags: [
          { name: 'category', value: 'content' },
          { name: 'type', value: 'content_ops_alert' },
        ],
      });
      logger.info({ type: 'content_ops_alert_sent', subject: input.subject });
      return true;
    } catch (error: unknown) {
      logger.error({ type: 'content_ops_alert_failed', subject: input.subject, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  /**
   * Retained for existing/future callers that only need "send this one-off
   * email, no persistence" - e.g. a caller with no natural (type, entityType,
   * entityId) identity to dedupe against. New editorial call sites should use
   * createOrIncrementAlert instead; this is now a thin wrapper, not the
   * primary public API.
   */
  async sendAlert(input: ContentOpsAlertInput): Promise<void> {
    await this.deliverEmail(input);
  }

  /**
   * Atomically persists (or increments/reopens) an alert, then decides
   * whether a notification is due and sends it best-effort. Always returns
   * the final persisted row, regardless of the notification outcome.
   */
  async createOrIncrementAlert(input: CreateOrIncrementAlertInput): Promise<ContentOpsAlert> {
    const { metadata: sanitizedMetadata, droppedKeys } = sanitizeAlertMetadata(input.metadata);
    if (droppedKeys.length > 0) {
      logger.warn({ type: 'content_ops_alert_metadata_fields_dropped', type_: input.type, entityType: input.entityType, entityId: input.entityId, droppedKeys });
    }

    const title = sanitizeAlertText(input.title, 200);
    const summary = sanitizeAlertText(input.summary);
    const nowVal = this.now();
    // Explicit application-generated ID: ContentOpsAlert.id's `@default(cuid())`
    // in schema.prisma is a Prisma-Client-side default (generated by the typed
    // client before insert), not a Postgres column default - this raw SQL
    // INSERT bypasses that client entirely, so it must supply its own ID, same
    // as reg-intel.agent.ts's persistSignal() does for RegulatorySignal.
    const id = randomUUID();

    const rows = await this.prisma.$queryRaw<ContentOpsAlert[]>`
      INSERT INTO "ContentOpsAlert" (
        "id", "type", "severity", "status", "title", "summary", "workflowKey", "executionId",
        "entityType", "entityId", "occurrenceCount", "firstSeenAt", "lastSeenAt",
        "notificationStatus", "notificationAttempts", "metadata", "createdAt", "updatedAt"
      ) VALUES (
        ${id}, ${input.type}, ${input.severity}::"AutomationIncidentSeverity", 'OPEN'::"AutomationIncidentStatus",
        ${title}, ${summary}, ${input.workflowKey ?? null}, ${input.executionId ?? null},
        ${input.entityType}, ${input.entityId}, 1, ${nowVal}, ${nowVal},
        'NOT_REQUIRED'::"ContentOpsAlertNotificationStatus", 0, ${JSON.stringify(sanitizedMetadata)}::jsonb, ${nowVal}, ${nowVal}
      )
      ON CONFLICT ("type", "entityType", "entityId", (COALESCE("workflowKey", '')))
      DO UPDATE SET
        "occurrenceCount" = "ContentOpsAlert"."occurrenceCount" + 1,
        "lastSeenAt" = ${nowVal},
        "title" = ${title},
        "summary" = ${summary},
        "executionId" = COALESCE(${input.executionId ?? null}, "ContentOpsAlert"."executionId"),
        "metadata" = ${JSON.stringify(sanitizedMetadata)}::jsonb,
        "status" = CASE WHEN "ContentOpsAlert"."status" IN ('RESOLVED', 'IGNORED') THEN 'OPEN'::"AutomationIncidentStatus" ELSE "ContentOpsAlert"."status" END,
        "acknowledgedAt" = CASE WHEN "ContentOpsAlert"."status" IN ('RESOLVED', 'IGNORED') THEN NULL ELSE "ContentOpsAlert"."acknowledgedAt" END,
        "acknowledgedById" = CASE WHEN "ContentOpsAlert"."status" IN ('RESOLVED', 'IGNORED') THEN NULL ELSE "ContentOpsAlert"."acknowledgedById" END,
        "resolvedAt" = CASE WHEN "ContentOpsAlert"."status" IN ('RESOLVED', 'IGNORED') THEN NULL ELSE "ContentOpsAlert"."resolvedAt" END,
        "resolvedById" = CASE WHEN "ContentOpsAlert"."status" IN ('RESOLVED', 'IGNORED') THEN NULL ELSE "ContentOpsAlert"."resolvedById" END,
        "updatedAt" = ${nowVal}
      RETURNING *
    `;

    const alert = rows[0];

    // Note: `reopened` cannot be reliably derived here - RETURNING * gives the
    // POST-update row, and Postgres's ON CONFLICT DO UPDATE has no clean way
    // to also return the pre-update status without a CTE. occurrenceCount > 1
    // reliably means "not the first occurrence"; whether that specific
    // transition was a reopen-from-RESOLVED/IGNORED vs. a plain duplicate
    // isn't distinguishable from this row alone, so it's not claimed in this
    // log line.
    logger.info({
      type: 'content_ops_alert_persisted',
      alertId: alert.id,
      alertType: input.type,
      entityType: input.entityType,
      entityId: input.entityId,
      severity: input.severity,
      status: alert.status,
      occurrenceCount: alert.occurrenceCount,
    });

    if (!NOTIFY_ELIGIBLE_SEVERITIES.includes(input.severity)) {
      // Lower-severity alerts persist without immediate email - notificationStatus
      // stays NOT_REQUIRED (this severity was never eligible), not SUPPRESSED
      // (which specifically means "was eligible but cooldown/policy blocked it").
      return alert;
    }

    const lastNotificationAt = alert.lastNotificationAt ? new Date(alert.lastNotificationAt).getTime() : null;
    const cooldownElapsed = lastNotificationAt === null || nowVal.getTime() - lastNotificationAt >= NOTIFICATION_COOLDOWN_MS;

    if (!cooldownElapsed) {
      return this.prisma.contentOpsAlert.update({
        where: { id: alert.id },
        data: { notificationStatus: 'SUPPRESSED' },
      });
    }

    const delivered = await this.deliverEmail({ subject: alert.title, summary: alert.summary });
    return this.markNotificationResult({ alertId: alert.id, status: delivered ? 'SENT' : 'FAILED' });
  }

  async acknowledgeAlert(input: AcknowledgeAlertInput): Promise<ContentOpsAlert> {
    return this.prisma.contentOpsAlert.update({
      where: { id: input.alertId },
      data: {
        status: 'ACKNOWLEDGED',
        acknowledgedById: input.by,
        acknowledgedAt: this.now(),
      },
    });
  }

  /**
   * Sets status=RESOLVED. resolutionNote, if provided, is sanitized and
   * persisted - but a resolutionNote from a PRIOR resolution is never cleared
   * by this service on its own (only an explicit new note overwrites it),
   * and createOrIncrementAlert's reopen logic never touches this column at
   * all, so history is preserved across a resolve -> reopen -> resolve cycle
   * unless an operator explicitly writes a new note each time.
   */
  async resolveAlert(input: ResolveAlertInput): Promise<ContentOpsAlert> {
    return this.prisma.contentOpsAlert.update({
      where: { id: input.alertId },
      data: {
        status: 'RESOLVED',
        resolvedById: input.by,
        resolvedAt: this.now(),
        ...(input.resolutionNote !== undefined ? { resolutionNote: sanitizeAlertText(input.resolutionNote) } : {}),
      },
    });
  }

  async listOpenAlerts(input: ListOpenAlertsInput = {}): Promise<ListOpenAlertsResult> {
    const page = input.page ?? 1;
    const limit = Math.min(input.limit ?? 20, 100);
    const where = {
      status: { in: ['OPEN', 'ACKNOWLEDGED'] as AutomationIncidentStatus[] },
      ...(input.severity ? { severity: input.severity } : {}),
      ...(input.type ? { type: input.type } : {}),
      ...(input.entityType ? { entityType: input.entityType } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.contentOpsAlert.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.contentOpsAlert.count({ where }),
    ]);

    return { rows, total };
  }

  async getAlert(alertId: string): Promise<ContentOpsAlert | null> {
    return this.prisma.contentOpsAlert.findUnique({ where: { id: alertId } });
  }

  async markNotificationResult(input: MarkNotificationResultInput): Promise<ContentOpsAlert> {
    return this.prisma.contentOpsAlert.update({
      where: { id: input.alertId },
      data: {
        notificationStatus: input.status,
        notificationAttempts: { increment: 1 },
        lastNotificationAt: this.now(),
      },
    });
  }
}

export const contentOpsAlertService = new ContentOpsAlertService();
