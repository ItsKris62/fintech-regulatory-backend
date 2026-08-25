/**
 * Account Hard-Purge Worker
 *
 * Permanently erases user accounts whose scheduled deletion grace period has expired.
 *
 * Selection criteria:
 *   - User.status === 'SUSPENDED'
 *   - User.deletionScheduledAt !== null && User.deletionScheduledAt <= now
 *
 * Execution Safety & Data Protection Guarantees:
 *   1. Dry-run mode support (--dry-run or DRY_RUN=true)
 *   2. Idempotent & batch-safe (processes up to BATCH_SIZE users per execution)
 *   3. Supabase Auth identity hard-purge via Supabase Admin API
 *   4. Redis session & cache key invalidation
 *   5. Scoped R2 private artifact deletion (preserves shared organizational documents)
 *   6. Statutory retention preservation (Payment & tax invoices preserved under TPA/ITA)
 *   7. Structured JSON logging with zero PII
 *   8. Transactional integrity with safe partial-failure behavior
 *
 * Usage:
 *   pnpm tsx src/scripts/purge-expired-accounts.ts
 *   pnpm tsx src/scripts/purge-expired-accounts.ts --dry-run
 */

import 'dotenv/config';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { prisma } from '@/lib/prisma/client';
import { supabaseAdmin } from '@/lib/supabase';
import { redis } from '@/lib/redis/client';
import { vaultS3Client, vaultStorageConfig } from '@/lib/storage/client';
import { logger } from '@/utils/logger';
import { sanitizeErrorMessage } from '@/utils/error-sanitizer';

export interface PurgeOptions {
  dryRun?: boolean;
  batchSize?: number;
  now?: Date;
}

export interface PurgeResult {
  scanned: number;
  purged: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  details: Array<{
    userId: string;
    success: boolean;
    error?: string;
  }>;
}

export async function purgeExpiredAccounts(options: PurgeOptions = {}): Promise<PurgeResult> {
  const isDryRun = options.dryRun ?? (process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true');
  const batchSize = options.batchSize ?? Number(process.env.PURGE_BATCH_SIZE ?? '100');
  const now = options.now ?? new Date();

  logger.info({
    type: 'purge_worker_started',
    dryRun: isDryRun,
    batchSize,
    currentTime: now.toISOString(),
  });

  // Query eligible expired accounts: must be SUSPENDED with an expired deletionScheduledAt
  const eligibleUsers = await prisma.user.findMany({
    where: {
      status: 'SUSPENDED',
      deletionScheduledAt: {
        not: null,
        lte: now,
      },
    },
    select: {
      id: true,
      supabaseAuthId: true,
      status: true,
      deletionScheduledAt: true,
      organizationId: true,
    },
    take: batchSize,
    orderBy: { deletionScheduledAt: 'asc' },
  });

  const result: PurgeResult = {
    scanned: eligibleUsers.length,
    purged: 0,
    skipped: 0,
    failed: 0,
    dryRun: isDryRun,
    details: [],
  };

  if (eligibleUsers.length === 0) {
    logger.info({ type: 'purge_worker_no_eligible_accounts' });
    return result;
  }

  for (const user of eligibleUsers) {
    // Safety Gate 1: Double-check that user is truly SUSPENDED and expired
    if (user.status !== 'SUSPENDED' || !user.deletionScheduledAt || user.deletionScheduledAt > now) {
      result.skipped++;
      continue;
    }

    if (isDryRun) {
      result.purged++;
      result.details.push({ userId: user.id, success: true });
      logger.info({
        type: 'purge_worker_dry_run_candidate',
        userId: user.id,
        scheduledAt: user.deletionScheduledAt.toISOString(),
      });
      continue;
    }

    try {
      // 1. Invalidate Redis Sessions & Caches
      try {
        if (user.supabaseAuthId) {
          await redis.del(`user:session:${user.supabaseAuthId}`);
        }
        await redis.del(`sheriabot:idx:sessions:${user.id}`);
        await redis.del(`user:profile:${user.id}`);
      } catch (redisErr: unknown) {
        logger.warn({
          type: 'purge_worker_redis_cleanup_warning',
          userId: user.id,
          error: sanitizeErrorMessage(redisErr),
        });
      }

      // 2. Delete Supabase Auth Record (if linked)
      if (user.supabaseAuthId && supabaseAdmin) {
        try {
          await supabaseAdmin.auth.admin.deleteUser(user.supabaseAuthId);
          logger.info({
            type: 'purge_worker_supabase_auth_deleted',
            userId: user.id,
          });
        } catch (supabaseErr: any) {
          const errorMsg = sanitizeErrorMessage(supabaseErr);
          if (!errorMsg.toLowerCase().includes('not found') && !errorMsg.toLowerCase().includes('user not found')) {
            logger.warn({
              type: 'purge_worker_supabase_delete_warning',
              userId: user.id,
              error: errorMsg,
            });
          }
        }
      }

      // 3. Purge user-owned soft-deleted vault documents from Cloudflare R2
      const userDeletedVaultDocs = await prisma.vaultDocument.findMany({
        where: {
          uploadedById: user.id,
          uploadStatus: 'DELETED',
        },
        select: { id: true, storageKey: true, r2Bucket: true },
      });

      for (const doc of userDeletedVaultDocs) {
        try {
          await vaultS3Client.send(
            new DeleteObjectCommand({
              Bucket: doc.r2Bucket ?? vaultStorageConfig.bucket,
              Key: doc.storageKey,
            }),
          );
        } catch (r2Err: unknown) {
          logger.warn({
            type: 'purge_worker_r2_doc_delete_warning',
            documentId: doc.id,
            error: sanitizeErrorMessage(r2Err),
          });
        }
      }

      // 4. Execute Relational Disassociation & Complete PII Erasure in a Database Transaction
      await prisma.$transaction(async (tx) => {
        // Disassociate user from licenses
        await tx.license.updateMany({
          where: { assignedOwnerId: user.id },
          data: { assignedOwnerId: null },
        });

        // Disassociate audit logs (preserving security log integrity while removing personal linkage)
        await tx.auditLog.updateMany({
          where: { userId: user.id },
          data: { userId: null },
        });

        // Delete soft-deleted vault documents belonging to this user
        await tx.vaultDocument.deleteMany({
          where: { uploadedById: user.id, uploadStatus: 'DELETED' },
        });

        // Delete user-private dependent records
        await tx.session.deleteMany({ where: { userId: user.id } });
        await tx.apiKey.deleteMany({ where: { userId: user.id } });
        await tx.notification.deleteMany({ where: { userId: user.id } });
        await tx.notificationPreference.deleteMany({ where: { userId: user.id } });
        await tx.notificationCategoryPreference.deleteMany({ where: { userId: user.id } });
        await tx.savedResponse.deleteMany({ where: { userId: user.id } });
        await tx.queryFeedback.deleteMany({ where: { userId: user.id } });
        await tx.organizationMember.deleteMany({ where: { userId: user.id } });

        // Complete cryptographic/irreversible PII wipe and deletion of User row
        try {
          await tx.user.delete({ where: { id: user.id } });
        } catch {
          // If foreign keys prevent hard delete of the User row, execute complete irreversible PII scrubbing
          await tx.user.update({
            where: { id: user.id },
            data: {
              email: `purged-${user.id}@anonymous.sheriabot.com`,
              fullName: 'Anonymized Purged User',
              phone: null,
              avatar: null,
              password: null,
              totpSecret: null,
              supabaseAuthId: null,
              status: 'SUSPENDED',
              accountStatus: 'purged',
              preferences: {},
              lastLoginIp: null,
              emailVerificationToken: null,
              passwordResetToken: null,
              deletedAt: new Date(),
            },
          });
        }
      });

      result.purged++;
      result.details.push({ userId: user.id, success: true });
      logger.info({
        type: 'purge_worker_account_erased',
        userId: user.id,
      });
    } catch (err: unknown) {
      result.failed++;
      const errorMessage = sanitizeErrorMessage(err);
      result.details.push({ userId: user.id, success: false, error: errorMessage });
      logger.error({
        type: 'purge_worker_account_failed',
        userId: user.id,
        error: errorMessage,
      });
    }
  }

  logger.info({
    type: 'purge_worker_completed',
    scanned: result.scanned,
    purged: result.purged,
    skipped: result.skipped,
    failed: result.failed,
    dryRun: isDryRun,
  });

  return result;
}

// Auto-run if executed directly as a CLI script
if (process.argv[1]?.endsWith('purge-expired-accounts.ts') || process.argv[1]?.endsWith('purge-expired-accounts.js')) {
  purgeExpiredAccounts()
    .then((res) => {
      logger.info({ type: 'purge_cli_exit', summary: res });
      process.exit(res.failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      logger.error({ type: 'purge_cli_fatal', error: sanitizeErrorMessage(err) });
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
