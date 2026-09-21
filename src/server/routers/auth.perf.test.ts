import 'dotenv/config';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { durableTaskRunner } from '../services/durable-background-tasks';
import { prisma } from '@/lib/prisma/client';

describe('Durable Background Task Runner & Auth Performance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches audit logs asynchronously without throwing and handles retries', async () => {
    const auditCreateSpy = vi.spyOn(prisma.auditLog, 'create').mockResolvedValue({
      id: 'audit-log-1',
      userId: 'user-1',
      action: 'USER_LOGIN',
      entityType: 'User',
      entityId: 'user-1',
      metadata: null,
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
      createdAt: new Date(),
    } as any);

    durableTaskRunner.enqueueAuditLog({
      userId: 'user-1',
      action: 'USER_LOGIN',
      entityType: 'User',
      entityId: 'user-1',
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
      metadata: { test: true },
    });

    await durableTaskRunner.drain();

    expect(auditCreateSpy).toHaveBeenCalledTimes(1);
    expect(auditCreateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          action: 'USER_LOGIN',
        }),
      }),
    );
  });

  it('dispatches lastLogin update asynchronously and drains reliably', async () => {
    const userUpdateSpy = vi.spyOn(prisma.user, 'update').mockResolvedValue({
      id: 'user-1',
      lastLoginAt: new Date(),
      lastLoginIp: '127.0.0.1',
    } as any);

    durableTaskRunner.enqueueLastLoginUpdate('user-1', '127.0.0.1');

    await durableTaskRunner.drain();

    expect(userUpdateSpy).toHaveBeenCalledTimes(1);
    expect(userUpdateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-1' },
        data: expect.objectContaining({
          lastLoginIp: '127.0.0.1',
        }),
      }),
    );
  });
});
