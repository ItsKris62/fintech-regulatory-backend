import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { documentModule } from '../document.module';
import { prisma } from '@/lib/prisma/client';
import { ragService } from '@/lib/rag/rag.service';
import { storageService } from '@/lib/storage/storage.service';

vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    legalDocument: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/rag/rag.service', () => ({
  ragService: {
    deleteDocument: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/lib/storage/storage.service', () => ({
  storageService: {
    deleteFile: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('documentModule.deleteDocument (soft delete without timer)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('performs soft delete, removes Pinecone vectors, and schedules no setTimeout timer', async () => {
    const docId = 'doc-test-123';
    const userId = 'user-owner-456';

    (prisma.legalDocument.findUnique as any).mockResolvedValue({
      id: docId,
      userId,
      fileUrl: 'legal-documents/test.pdf',
      organizationId: 'org-1',
      deletedAt: null,
    });

    (prisma.user.findUnique as any).mockResolvedValue({
      id: userId,
      role: 'USER',
    });

    (prisma.legalDocument.update as any).mockResolvedValue({
      id: docId,
      contentStatus: 'ARCHIVED',
      deletedAt: new Date('2026-09-23T12:00:00Z'),
    });

    await documentModule.deleteDocument(docId, userId);

    // 1. prisma.legalDocument.update is called to soft-delete
    expect(prisma.legalDocument.update).toHaveBeenCalledTimes(1);
    expect(prisma.legalDocument.update).toHaveBeenCalledWith({
      where: { id: docId },
      data: { contentStatus: 'ARCHIVED', deletedAt: expect.any(Date) },
    });

    // 2. vi.getTimerCount() is 0 (no setTimeout scheduled)
    expect(vi.getTimerCount()).toBe(0);

    // 3. Pinecone delete is called synchronously
    expect(ragService.deleteDocument).toHaveBeenCalledTimes(1);
    expect(ragService.deleteDocument).toHaveBeenCalledWith(docId);

    // 4. Advancing timers 31 days causes no deferred delete or storage delete
    await vi.advanceTimersByTimeAsync(31 * 24 * 60 * 60 * 1000);

    expect(prisma.legalDocument.delete).not.toHaveBeenCalled();
    expect(storageService.deleteFile).not.toHaveBeenCalled();
  });
});
