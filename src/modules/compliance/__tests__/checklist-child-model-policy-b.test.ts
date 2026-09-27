import { describe, expect, it, vi, beforeEach } from 'vitest';
import { checklistService } from '../checklist.service';
import { prisma } from '@/lib/prisma/client';
import { NotFoundError } from '@/utils/error';

vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    checklistItem: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    checklist: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    organizationMember: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(async (cb) => cb(prisma)),
  },
}));

vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Checklist Child Model Policy B Isolation (Phase 1.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects cross-tenant child ChecklistItem mutation under Policy B relation scoping', async () => {
    // If an attacker in org_attacker tries to mutate an item owned by org_victim,
    // Policy B scopes the query through checklist.organizationId, returning null.
    (prisma.checklistItem.findFirst as any).mockResolvedValue(null);

    await expect(
      checklistService.updateItemStatus('user_attacker', 'org_attacker', {
        itemId: 'item_victim_999',
        status: 'COMPLETED',
      })
    ).rejects.toThrow(NotFoundError);

    expect(prisma.checklistItem.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'item_victim_999',
        checklist: {
          organizationId: 'org_attacker',
          deletedAt: null,
        },
      },
    });
  });
});
