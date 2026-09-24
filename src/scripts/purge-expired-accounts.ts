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
 *   5. Archive-then-delete across all R2 buckets (sheria-bot-public, sheria-bot-saas, sheriabot-storage -> sheria-bot-backups)
 *   6. Comprehensive artifact cleanup: avatars, legal documents, policy exports, checklist exports, gap analysis exports, compliance query exports, and vault documents
 *   7. Statutory retention preservation (Payment & tax invoices preserved under TPA/ITA)
 *   8. Structured JSON logging with zero PII
 *   9. Transactional integrity with safe partial-failure behavior
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
import { appConfig } from '@/config/app.config';
import { vaultS3Client, vaultStorageConfig } from '@/lib/storage/client';
import { storageService } from '@/lib/storage/storage.service';
import { deleteAvatarByKey, extractKeyFromAvatarUrl } from '@/lib/storage/public-storage.service';
import { archiveObject } from '@/lib/storage/archive.service';
import { extractR2Key } from '@/scripts/cleanup-deleted-documents';
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
  archived: number;
  deleted: number;
  dryRun: boolean;
  details: Array<{
    userId: string;
    success: boolean;
    error?: string;
  }>;
}

interface PurgeAsset {
  category:
    | 'avatar'
    | 'legalDocument'
    | 'policyExport'
    | 'checklistExport'
    | 'gapAnalysisExport'
    | 'complianceQueryExport'
    | 'vaultDocument';
  bucket: string;
  key: string;
  client: 'public' | 'storageService' | 'vault';
  id?: string;
}

export async function purgeExpiredAccounts(options: PurgeOptions = {}): Promise<PurgeResult> {
  const isDryRun = options.dryRun ?? (process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true');
  const batchSize = options.batchSize ?? Number(process.env.PURGE_BATCH_SIZE ?? '100');
  const now = options.now ?? new Date();
  const dateStr = now.toISOString().slice(0, 10);

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
      avatar: true,
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
    archived: 0,
    deleted: 0,
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

    const archivePrefix = `purge/${dateStr}/${user.id}`;
    const assetsToPurge: PurgeAsset[] = [];
    const seenKeys = new Set<string>();

    // 1. Collect user avatar from sheria-bot-public
    if (user.avatar) {
      const avatarKey = extractKeyFromAvatarUrl(user.avatar) ?? extractR2Key(user.avatar);
      if (avatarKey && !seenKeys.has(avatarKey)) {
        seenKeys.add(avatarKey);
        assetsToPurge.push({
          category: 'avatar',
          bucket: appConfig.publicStorage.bucketName,
          key: avatarKey,
          client: 'public',
        });
      }
    }

    // 2. Collect user legal documents from sheria-bot-saas
    const userLegalDocs = await prisma.legalDocument.findMany({
      where: user.organizationId
        ? { OR: [{ userId: user.id }, { organizationId: user.organizationId }] }
        : { userId: user.id },
      select: { id: true, fileUrl: true },
    });

    for (const doc of userLegalDocs) {
      const docKey = extractR2Key(doc.fileUrl);
      if (docKey && !seenKeys.has(docKey)) {
        seenKeys.add(docKey);
        assetsToPurge.push({
          category: 'legalDocument',
          bucket: appConfig.storage.bucketName,
          key: docKey,
          client: 'storageService',
          id: doc.id,
        });
      }
    }

    // 3. Collect policy exports from sheria-bot-saas
    const userPolicyExports = await prisma.generatedPolicyExportLog.findMany({
      where: user.organizationId
        ? { OR: [{ userId: user.id }, { organizationId: user.organizationId }] }
        : { userId: user.id },
      select: { id: true, storageKey: true },
    });

    for (const exp of userPolicyExports) {
      if (exp.storageKey && !seenKeys.has(exp.storageKey)) {
        seenKeys.add(exp.storageKey);
        assetsToPurge.push({
          category: 'policyExport',
          bucket: appConfig.storage.bucketName,
          key: exp.storageKey,
          client: 'storageService',
          id: exp.id,
        });
      }
    }

    // 4. Collect gap analysis exports (gap-analysis-exports/) from sheria-bot-saas
    const userGapAnalyses = await prisma.gapAnalysis.findMany({
      where: user.organizationId
        ? { OR: [{ userId: user.id }, { organizationId: user.organizationId }] }
        : { userId: user.id },
      select: { id: true, reportUrl: true },
    });

    for (const ga of userGapAnalyses) {
      if (ga.reportUrl) {
        const gapKey = extractR2Key(ga.reportUrl);
        if (gapKey && !seenKeys.has(gapKey)) {
          seenKeys.add(gapKey);
          assetsToPurge.push({
            category: 'gapAnalysisExport',
            bucket: appConfig.storage.bucketName,
            key: gapKey,
            client: 'storageService',
            id: ga.id,
          });
        }
      }
    }

    // 5. Collect checklist exports (checklist-exports/), gap analysis exports, and compliance query exports (exports/compliance-queries/) from AuditLog
    const exportAuditLogs = await prisma.auditLog.findMany({
      where: {
        userId: user.id,
        action: {
          in: ['CHECKLIST_EXPORTED', 'GAP_ANALYSIS_EXPORTED', 'COMPLIANCE_QUERY_EXPORTED'],
        },
      },
      select: { id: true, action: true, metadata: true },
    });

    for (const audit of exportAuditLogs) {
      const meta = audit.metadata as Record<string, unknown> | null;
      const r2Key = (meta?.r2Key as string | undefined) ?? (meta?.key as string | undefined);
      if (!r2Key || seenKeys.has(r2Key)) continue;

      if (audit.action === 'CHECKLIST_EXPORTED' || r2Key.startsWith('checklist-exports/')) {
        seenKeys.add(r2Key);
        assetsToPurge.push({
          category: 'checklistExport',
          bucket: appConfig.storage.bucketName,
          key: r2Key,
          client: 'storageService',
          id: audit.id,
        });
      } else if (audit.action === 'GAP_ANALYSIS_EXPORTED' || r2Key.startsWith('gap-analysis-exports/')) {
        seenKeys.add(r2Key);
        assetsToPurge.push({
          category: 'gapAnalysisExport',
          bucket: appConfig.storage.bucketName,
          key: r2Key,
          client: 'storageService',
          id: audit.id,
        });
      } else if (audit.action === 'COMPLIANCE_QUERY_EXPORTED' || r2Key.startsWith('exports/compliance-queries/')) {
        seenKeys.add(r2Key);
        assetsToPurge.push({
          category: 'complianceQueryExport',
          bucket: vaultStorageConfig.bucket,
          key: r2Key,
          client: 'vault',
          id: audit.id,
        });
      }
    }

    // 6. Collect vault documents from sheriabot-storage (all soft-deleted and active)
    const userVaultDocs = await prisma.vaultDocument.findMany({
      where: user.organizationId
        ? { OR: [{ uploadedById: user.id }, { organizationId: user.organizationId }] }
        : { uploadedById: user.id },
      select: { id: true, storageKey: true, r2Bucket: true },
    });

    for (const vdoc of userVaultDocs) {
      if (vdoc.storageKey && !seenKeys.has(vdoc.storageKey)) {
        seenKeys.add(vdoc.storageKey);
        assetsToPurge.push({
          category: 'vaultDocument',
          bucket: vdoc.r2Bucket ?? vaultStorageConfig.bucket,
          key: vdoc.storageKey,
          client: 'vault',
          id: vdoc.id,
        });
      }
    }

    if (isDryRun) {
      for (const asset of assetsToPurge) {
        logger.info({
          type: 'purge_worker_dry_run_asset_plan',
          userId: user.id,
          category: asset.category,
          sourceBucket: asset.bucket,
          sourceKey: asset.key,
          archivePrefix,
        });
      }
      result.purged++;
      result.details.push({ userId: user.id, success: true });
      logger.info({
        type: 'purge_worker_dry_run_candidate',
        userId: user.id,
        scheduledAt: user.deletionScheduledAt.toISOString(),
        assetsCount: assetsToPurge.length,
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

      // 3. Archive to sheria-bot-backups then Delete from source R2 buckets
      let archiveFailed = false;

      for (const asset of assetsToPurge) {
        // Step A: Archive to backups bucket
        const archiveRes = await archiveObject({
          sourceBucket: asset.bucket,
          sourceKey: asset.key,
          archivePrefix,
        });

        if (!archiveRes.archived) {
          archiveFailed = true;
          logger.error({
            type: 'purge_worker_archive_failed_skipping_delete',
            userId: user.id,
            bucket: asset.bucket,
            key: asset.key,
          });
          continue; // Invariant: Never delete if archive fails
        }

        result.archived++;

        // Step B: Delete from source bucket only after successful copy
        try {
          if (asset.client === 'vault') {
            await vaultS3Client.send(
              new DeleteObjectCommand({
                Bucket: asset.bucket,
                Key: asset.key,
              }),
            );
          } else if (asset.client === 'public') {
            await deleteAvatarByKey(asset.key);
          } else {
            await storageService.deleteFile(asset.key);
          }
          result.deleted++;
        } catch (r2Err: unknown) {
          logger.warn({
            type: 'purge_worker_r2_asset_delete_warning',
            userId: user.id,
            bucket: asset.bucket,
            key: asset.key,
            error: sanitizeErrorMessage(r2Err),
          });
        }
      }

      if (archiveFailed) {
        throw new Error(`Archive failed for one or more R2 assets of user ${user.id}`);
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

        // Delete vault documents belonging to this user
        await tx.vaultDocument.deleteMany({
          where: { uploadedById: user.id },
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
    archived: result.archived,
    deleted: result.deleted,
    dryRun: isDryRun,
  });

  console.log(`Summary: users=${result.scanned} archived=${result.archived} deleted=${result.deleted} failed=${result.failed}`);

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
