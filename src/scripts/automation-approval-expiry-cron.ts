/**
 * Automation Approval Expiry Cron Job
 *
 * Ages out PENDING AutomationApproval rows nobody ever decided on
 * (createApproval sets a 24h expiresAt). Approvals gate content publication
 * and similar customer-facing actions, so an hour of staleness tolerance
 * between expiry and this sweep is acceptable - not worth a tighter interval.
 *
 * Render Cron Job config:
 *   Command:  pnpm automation-approval-expiry:cron
 *   Schedule: 0 * * * *  (hourly)
 *   Region:   Same region as the API service
 */

import 'dotenv/config';
import { automationApprovalService } from '@/modules/agents/automation/approval.service';
import { logger } from '@/utils/logger';

async function main(): Promise<void> {
  logger.info({ type: 'automation_approval_expiry.cron.start' });

  try {
    const count = await automationApprovalService.expireStalePendingApprovals();
    logger.info({ type: 'automation_approval_expiry.cron.exit', success: true, count });
    process.exit(0);
  } catch (err: unknown) {
    logger.error({
      type: 'automation_approval_expiry.cron.exit',
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

void main();
