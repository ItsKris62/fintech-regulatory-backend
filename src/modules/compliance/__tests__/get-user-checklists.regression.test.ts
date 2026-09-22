import { describe, expect, it, vi, beforeEach } from 'vitest';
import { complianceModule } from '../compliance.module';
import { prisma } from '@/lib/prisma/client';

vi.mock('@/lib/prisma/client', () => {
  return {
    prisma: {
      checklist: {
        findMany: vi.fn(),
      },
    },
  };
});

vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  },
}));

describe('getUserChecklists Regression Test (Crash Fix & OrganizationId Projection)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('selects organizationId and returns 200/valid data structure for authenticated user', async () => {
    const mockChecklistDbRow = {
      id: 'chk_123',
      organizationId: 'org_abc',
      title: 'Kenya Fintech Regulatory Baseline',
      productType: 'Digital Lending',
      businessStage: 'Growth',
      targetSegments: ['Retail'],
      servicesOffered: ['Microloans'],
      additionalConcerns: null,
      progress: 40,
      status: 'READY',
      totalItems: 5,
      completedItems: 0,
      checklistData: null,
      checklistItems: [
        { id: 'item_1', priority: 'HIGH', status: 'PENDING' },
        { id: 'item_2', priority: 'CRITICAL', status: 'PENDING' },
        { id: 'item_3', priority: 'HIGH', status: 'PENDING' },
        { id: 'item_4', priority: 'MEDIUM', status: 'PENDING' },
        { id: 'item_5', priority: 'MEDIUM', status: 'PENDING' },
      ],
      createdAt: new Date('2026-09-20T10:00:00Z'),
      updatedAt: new Date('2026-09-20T12:00:00Z'),
    };

    (prisma.checklist.findMany as any).mockResolvedValue([mockChecklistDbRow]);

    const result = await complianceModule.getUserChecklists('user_123', 'org_abc');

    expect(prisma.checklist.findMany).toHaveBeenCalledWith({
      where: {
        userId: 'user_123',
        organizationId: 'org_abc',
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        organizationId: true,
        title: true,
        productType: true,
        businessStage: true,
        targetSegments: true,
        servicesOffered: true,
        additionalConcerns: true,
        progress: true,
        status: true,
        totalItems: true,
        completedItems: true,
        checklistData: true,
        checklistItems: {
          select: {
            id: true,
            priority: true,
            status: true,
          },
        },
        createdAt: true,
        updatedAt: true,
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0].totalItems).toBe(5);
    expect(result[0].criticalItems).toBe(3); // item_1 (HIGH), item_2 (CRITICAL), item_3 (HIGH)
    expect(result[0].totalItems).toBeGreaterThanOrEqual(5);
    expect(result[0].criticalItems).toBeGreaterThanOrEqual(1);
  });
});
