import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { UserRole, UserStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma/client';
import { assertSafeTestDatabase } from '@/utils/destructive-test-safety';
import { compensateGapAnalysisUsage } from './gap-analysis-usage-accounting';
import {
  enqueueGapAnalysisObjectDeletion,
  processGapAnalysisObjectDeletionBatch,
} from './gap-analysis-object-deletion';
import { AiJobLeaseLostError, renewAiJobLease } from '@/modules/ai-jobs/ai-job-lease';
import { storageService } from '@/lib/storage/storage.service';

vi.mock('@/lib/storage/storage.service', () => ({
  storageService: { deleteFile: vi.fn().mockResolvedValue(undefined) },
}));

const safeDatabaseEnvironments = new Set(['development-uat', 'preview']);
const databaseEnvironment = process.env.DATABASE_ENVIRONMENT?.trim().toLowerCase() ?? 'unknown';
const canRunDatabaseTests = safeDatabaseEnvironments.has(databaseEnvironment) && Boolean(process.env.DATABASE_URL);
const describeIfSafeDb = canRunDatabaseTests ? describe : describe.skip;

describeIfSafeDb('Gap Analysis real PostgreSQL release safeguards', () => {
  const marker = `gap-release-${randomUUID().slice(0, 8)}`;
  const organizationId = `${marker}-org`;
  const userId = `${marker}-user`;
  const analysisId = `${marker}-analysis`;
  const objectKey = `gap-analysis/${organizationId}/${analysisId}/synthetic-policy.pdf`;

  beforeAll(async () => {
    assertSafeTestDatabase();
    await prisma.organization.create({
      data: { id: organizationId, name: marker, type: 'startup' },
    });
    await prisma.user.create({
      data: {
        id: userId,
        email: `${marker}@sheriabot.test`,
        fullName: 'Gap Release Test User',
        role: UserRole.STARTUP,
        status: UserStatus.ACTIVE,
        accountStatus: 'active',
        emailVerified: true,
        preferences: {},
        organizationId,
      },
    });
    await prisma.gapAnalysis.create({
      data: {
        id: analysisId,
        userId,
        organizationId,
        documentName: 'synthetic-policy.pdf',
        documentUrl: objectKey,
        documentType: 'application/pdf',
        regulatoryFrameworks: ['synthetic-framework'],
        analysisDepth: 'standard',
        status: 'FAILED',
        deletedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await prisma.aiJob.deleteMany({ where: { idempotencyKey: { startsWith: marker } } });
    await prisma.gapAnalysisObjectDeletion.deleteMany({ where: { organizationId } });
    await prisma.gapAnalysisUsageLedger.deleteMany({ where: { organizationId } });
    await prisma.gapAnalysis.deleteMany({ where: { organizationId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  it('releases an unlimited usage reservation idempotently under concurrency', async () => {
    await prisma.gapAnalysisUsageLedger.create({
      data: {
        id: `${marker}-ledger`,
        analysisId,
        organizationId,
        userId,
        scope: 'UNLIMITED',
        units: 1,
        reservationKey: `${marker}-reservation`,
      },
    });

    await Promise.all([
      compensateGapAnalysisUsage({ analysisId, organizationId, userId, failureClass: 'TEST_FAILURE' }),
      compensateGapAnalysisUsage({ analysisId, organizationId, userId, failureClass: 'TEST_FAILURE' }),
    ]);

    const ledger = await prisma.gapAnalysisUsageLedger.findUniqueOrThrow({ where: { analysisId } });
    expect(ledger.state).toBe('RELEASED');
    expect(ledger.failureClass).toBe('TEST_FAILURE');
    expect(ledger.releasedAt).not.toBeNull();
  });

  it('fences a stale worker generation while allowing the current lease to renew', async () => {
    const job = await prisma.aiJob.create({
      data: {
        type: 'GAP_ANALYSIS',
        status: 'RUNNING',
        idempotencyKey: `${marker}-job`,
        targetEntityType: 'GapAnalysis',
        targetEntityId: analysisId,
        userId,
        organizationId,
        payload: {},
        attempts: 2,
        lockedBy: `${marker}-worker-current`,
        lockedAt: new Date(0),
      },
    });

    await expect(renewAiJobLease({ jobId: job.id, workerId: `${marker}-worker-stale`, attempt: 1 }))
      .rejects.toBeInstanceOf(AiJobLeaseLostError);
    const renewedAt = new Date();
    await renewAiJobLease({ jobId: job.id, workerId: `${marker}-worker-current`, attempt: 2 }, renewedAt);

    const persisted = await prisma.aiJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(persisted.lockedAt?.getTime()).toBe(renewedAt.getTime());
  });

  it('deduplicates the deletion outbox and completes only an owned object', async () => {
    const input = {
      analysisId,
      organizationId,
      userId,
      objectKey,
      objectType: 'SOURCE' as const,
      reason: 'RETENTION_TEST',
    };
    await Promise.all([
      enqueueGapAnalysisObjectDeletion(input),
      enqueueGapAnalysisObjectDeletion(input),
    ]);

    expect(await prisma.gapAnalysisObjectDeletion.count({ where: { analysisId, objectKey } })).toBe(1);
    const result = await processGapAnalysisObjectDeletionBatch(1);
    expect(result).toEqual({ completed: 1, failed: 0, skipped: 0 });
    expect(storageService.deleteFile).toHaveBeenCalledWith(objectKey);
    const outbox = await prisma.gapAnalysisObjectDeletion.findFirstOrThrow({ where: { analysisId, objectKey } });
    expect(outbox.status).toBe('COMPLETED');
  });

  it('rolls back the analysis and ledger together when a transaction fails', async () => {
    const rolledBackAnalysisId = `${marker}-rollback-analysis`;
    await expect(prisma.$transaction(async (tx) => {
      await tx.gapAnalysis.create({
        data: {
          id: rolledBackAnalysisId,
          userId,
          organizationId,
          documentName: 'rollback.pdf',
          documentUrl: `gap-analysis/${organizationId}/${rolledBackAnalysisId}/rollback.pdf`,
          documentType: 'application/pdf',
          regulatoryFrameworks: [],
        },
      });
      await tx.gapAnalysisUsageLedger.create({
        data: {
          id: `${marker}-rollback-ledger`,
          analysisId: rolledBackAnalysisId,
          organizationId,
          userId,
          scope: 'UNLIMITED',
          units: 1,
          reservationKey: `${marker}-rollback-reservation`,
        },
      });
      throw new Error('force rollback');
    })).rejects.toThrow('force rollback');

    expect(await prisma.gapAnalysis.findUnique({ where: { id: rolledBackAnalysisId } })).toBeNull();
    expect(await prisma.gapAnalysisUsageLedger.findUnique({ where: { analysisId: rolledBackAnalysisId } })).toBeNull();
  });
});
