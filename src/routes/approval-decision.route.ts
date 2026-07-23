import type { FastifyInstance } from 'fastify';
import { TRPCError } from '@trpc/server';
import { appConfig } from '@/config/app.config';
import { logger } from '@/utils/logger';
import { escapeHtml } from '@/utils/html-escape';
import { sanitizeErrorMessage } from '@/utils/error-sanitizer';
import { hashIp } from '@/utils/request-identifiers';
import { rateLimiter } from '@/lib/redis/rate-limiter';
import { verifyApprovalDecisionLink } from '@/modules/agents/automation/approval-decision-link-signature';
import { automationApprovalService, type AutomationApprovalService, type ApprovalDecision } from '@/modules/agents/automation/approval.service';

// Public, unauthenticated routes backing the emailed approval-decision link.
// GET renders a confirmation page with zero side effects (safe for email
// clients/security scanners that auto-fetch links); only the POST - a real
// button click - records a decision. See createApproval's
// sendReviewerNotification for how this link is generated and signed.

const VIEW_RATE_LIMIT_MAX = 30;
const VIEW_RATE_LIMIT_WINDOW_SECONDS = 60;
const SUBMIT_RATE_LIMIT_MAX = 10;
const SUBMIT_RATE_LIMIT_WINDOW_SECONDS = 60;

type ApprovalServiceLike = Pick<AutomationApprovalService, 'getApprovalPublicView' | 'recordApprovalDecision'>;
type RateLimitCheck = typeof rateLimiter.check;

export interface ApprovalDecisionRouteDependencies {
  approvalService?: ApprovalServiceLike;
  decisionLinkSecret?: string;
  now?: () => Date;
  rateLimitCheck?: RateLimitCheck;
}

interface DecisionToken {
  approvalId: string;
  expiresAtSeconds: number;
  signature: string;
}

const EXP_PATTERN = /^[0-9]{1,10}$/;
const SIG_PATTERN = /^[a-f0-9]{64}$/;

function parseDecisionToken(source: { approvalId?: unknown; exp?: unknown; sig?: unknown }): DecisionToken | null {
  const { approvalId, exp, sig } = source;
  if (typeof approvalId !== 'string' || approvalId.length === 0 || approvalId.length > 200) return null;
  if (typeof exp !== 'string' || !EXP_PATTERN.test(exp)) return null;
  if (typeof sig !== 'string' || !SIG_PATTERN.test(sig)) return null;
  return { approvalId, expiresAtSeconds: Number(exp), signature: sig };
}

function pageShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  body {
    background: #000000;
    color: #FFFFFF;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    max-width: 560px;
    margin: 0 auto;
    padding: 48px 24px;
    line-height: 1.6;
  }
  .card {
    background: #0A0A0A;
    border: 1px solid #1F2937;
    border-radius: 8px;
    padding: 32px;
  }
  h1 {
    color: #22C55E;
    font-size: 22px;
    margin: 0 0 16px;
  }
  p { color: #D1D5DB; }
  .label { color: #9CA3AF; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; }
  .actions { margin-top: 28px; display: flex; gap: 12px; }
  button {
    flex: 1;
    padding: 14px 20px;
    border-radius: 6px;
    font-weight: 600;
    font-size: 15px;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .approve { background: #22C55E; color: #000000; }
  .reject { background: #000000; color: #EF4444; border-color: #EF4444; }
</style>
</head>
<body>
  <div class="card">
${body}
  </div>
</body>
</html>`;
}

function renderErrorPage(message: string): string {
  return pageShell('Approval link', `    <h1>This link can't be used</h1>\n    <p>${escapeHtml(message)}</p>`);
}

function renderConfirmationPage(args: {
  department: string;
  workflow: string;
  summary: string;
  approvalId: string;
  expiresAtSeconds: number;
  signature: string;
}): string {
  const hiddenFields = `
      <input type="hidden" name="approvalId" value="${escapeHtml(args.approvalId)}">
      <input type="hidden" name="exp" value="${args.expiresAtSeconds}">
      <input type="hidden" name="sig" value="${escapeHtml(args.signature)}">`;

  return pageShell('Approval needed', `
    <h1>Approval needed</h1>
    <p class="label">Department</p>
    <p>${escapeHtml(args.department)}</p>
    <p class="label">Workflow</p>
    <p>${escapeHtml(args.workflow)}</p>
    <p class="label">Summary</p>
    <p>${escapeHtml(args.summary)}</p>
    <div class="actions">
      <form method="POST" action="/approvals/decide" style="flex:1">${hiddenFields}
        <input type="hidden" name="decision" value="approved">
        <button type="submit" class="approve">Approve</button>
      </form>
      <form method="POST" action="/approvals/decide" style="flex:1">${hiddenFields}
        <input type="hidden" name="decision" value="rejected">
        <button type="submit" class="reject">Reject</button>
      </form>
    </div>`);
}

function renderResultPage(decision: ApprovalDecision): string {
  const label = decision === 'approved' ? 'Approved' : 'Rejected';
  return pageShell('Decision recorded', `    <h1>${label}</h1>\n    <p>Your decision has been recorded.</p>`);
}

export function registerApprovalDecisionRoutes(app: FastifyInstance, dependencies: ApprovalDecisionRouteDependencies = {}): void {
  const approvalService: ApprovalServiceLike = dependencies.approvalService ?? automationApprovalService;
  const decisionLinkSecret = dependencies.decisionLinkSecret ?? appConfig.agents.automation.decisionLinkSecret;
  const now = dependencies.now ?? (() => new Date());
  const rateLimitCheck: RateLimitCheck = dependencies.rateLimitCheck ?? rateLimiter.check.bind(rateLimiter);

  app.get<{ Querystring: { approvalId?: string; exp?: string; sig?: string } }>(
    '/approvals/decide',
    async (request, reply) => {
      const rl = await rateLimitCheck(hashIp(request.ip), 'approval-decision-view', VIEW_RATE_LIMIT_MAX, VIEW_RATE_LIMIT_WINDOW_SECONDS, { failClosed: true });
      if (!rl.allowed) {
        logger.warn({ type: 'approval_decision_view_rate_limited', ipHash: hashIp(request.ip) });
        return reply.status(429).type('text/html').send(renderErrorPage('Too many requests. Please try again shortly.'));
      }

      const token = parseDecisionToken(request.query);
      if (!token) {
        logger.warn({ type: 'approval_decision_link_malformed', ipHash: hashIp(request.ip) });
        return reply.status(400).type('text/html').send(renderErrorPage('This link is invalid.'));
      }

      const verification = verifyApprovalDecisionLink(decisionLinkSecret, {
        approvalId: token.approvalId,
        expiresAtSeconds: token.expiresAtSeconds,
        signature: token.signature,
        nowSeconds: Math.floor(now().getTime() / 1000),
      });

      if (!verification.valid) {
        logger.warn({ type: 'approval_decision_link_rejected', reason: verification.reason, approvalId: token.approvalId });
        return reply.status(400).type('text/html').send(renderErrorPage('This link is invalid or has expired.'));
      }

      // Zero side effects below this point: a plain read plus a page-view log,
      // no mutation, no calls to any decision-recording method - safe for an
      // email client or scanner to auto-fetch, even repeatedly.
      const approval = await approvalService.getApprovalPublicView(token.approvalId);
      if (!approval) {
        logger.warn({ type: 'approval_decision_link_not_found', approvalId: token.approvalId });
        return reply.status(404).type('text/html').send(renderErrorPage('This approval could not be found.'));
      }

      logger.info({ type: 'approval_decision_page_viewed', approvalId: token.approvalId, status: approval.status });

      return reply.status(200).type('text/html').send(renderConfirmationPage({
        department: approval.department,
        workflow: approval.workflow,
        summary: approval.summary,
        approvalId: token.approvalId,
        expiresAtSeconds: token.expiresAtSeconds,
        signature: token.signature,
      }));
    },
  );

  app.post<{ Body: { approvalId?: string; exp?: string; sig?: string; decision?: string } }>(
    '/approvals/decide',
    async (request, reply) => {
      const rl = await rateLimitCheck(hashIp(request.ip), 'approval-decision-submit', SUBMIT_RATE_LIMIT_MAX, SUBMIT_RATE_LIMIT_WINDOW_SECONDS, { failClosed: true });
      if (!rl.allowed) {
        logger.warn({ type: 'approval_decision_submit_rate_limited', ipHash: hashIp(request.ip) });
        return reply.status(429).type('text/html').send(renderErrorPage('Too many requests. Please try again shortly.'));
      }

      const body = request.body ?? {};
      const token = parseDecisionToken(body);
      const decision = body.decision;

      if (!token || (decision !== 'approved' && decision !== 'rejected')) {
        logger.warn({ type: 'approval_decision_submit_malformed', ipHash: hashIp(request.ip) });
        return reply.status(400).type('text/html').send(renderErrorPage('This request is invalid.'));
      }

      // Independently re-verified - this route does not trust that the GET
      // page already checked the signature/expiry, since it can in principle
      // be hit directly without ever loading the confirmation page.
      const verification = verifyApprovalDecisionLink(decisionLinkSecret, {
        approvalId: token.approvalId,
        expiresAtSeconds: token.expiresAtSeconds,
        signature: token.signature,
        nowSeconds: Math.floor(now().getTime() / 1000),
      });

      if (!verification.valid) {
        logger.warn({ type: 'approval_decision_submit_rejected', reason: verification.reason, approvalId: token.approvalId });
        return reply.status(400).type('text/html').send(renderErrorPage('This link is invalid or has expired.'));
      }

      const approval = await approvalService.getApprovalPublicView(token.approvalId);
      const reviewerEmail = approval?.reviewerEmail ?? 'unknown';

      try {
        const result = await approvalService.recordApprovalDecision({
          approvalId: token.approvalId,
          decision,
          // Marks this decision as having come via the emailed link rather
          // than an authenticated admin-dashboard session - preserves the
          // audit trail's honesty about how the decision was made.
          by: `email-link:${reviewerEmail}`,
        });

        logger.info({ type: 'approval_decision_submitted', approvalId: token.approvalId, decision: result.status });
        return reply.status(200).type('text/html').send(renderResultPage(result.status as ApprovalDecision));
      } catch (error: unknown) {
        const statusCode = error instanceof TRPCError
          ? error.code === 'NOT_FOUND' ? 404
            : error.code === 'CONFLICT' ? 409
            : error.code === 'BAD_REQUEST' ? 400
            : 500
          : 500;

        logger.warn({
          type: 'approval_decision_submit_failed',
          approvalId: token.approvalId,
          error: sanitizeErrorMessage(error),
        });
        return reply.status(statusCode).type('text/html').send(renderErrorPage(sanitizeErrorMessage(error)));
      }
    },
  );
}
