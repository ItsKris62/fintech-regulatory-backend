import { describe, expect, it, vi, beforeEach } from 'vitest';
import { loadSystemConfig, SYSTEM_CONFIG_DEFINITIONS } from '../system-config';

const { mockRedis, mockPrisma } = vi.hoisted(() => {
  return {
    mockRedis: {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue('OK'),
    },
    mockPrisma: {
      systemConfig: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockImplementation((args) => args),
        count: vi.fn(),
      },
      $transaction: vi.fn().mockImplementation(async (ops) => ops),
    },
  };
});

vi.mock('@/lib/redis/client', () => ({
  redis: mockRedis,
}));

vi.mock('@/lib/prisma/client', () => ({
  prisma: mockPrisma,
}));

describe('loadSystemConfig cache bypass and definition sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('bypasses warm Redis cache and executes persistDatabaseRows for all 26 definitions when syncDefinitions: true is passed', async () => {
    // 1. Warm Redis cache
    mockRedis.get.mockResolvedValue(JSON.stringify({
      maintenanceMode: false,
      allowNewRegistrations: true,
    }));

    // 2. Call loadSystemConfig with syncDefinitions: true
    const result = await loadSystemConfig({ syncDefinitions: true });

    expect(result).toBeDefined();
    // Verify that upsert was prepared for all canonical definitions
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    const operations = mockPrisma.$transaction.mock.calls[0][0];
    expect(operations).toHaveLength(26);
    expect(operations).toHaveLength(SYSTEM_CONFIG_DEFINITIONS.length);
  });
});
