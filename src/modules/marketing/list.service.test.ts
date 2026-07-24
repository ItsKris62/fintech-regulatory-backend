import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDynamicContactWhere, resolveContacts } from './list.service';
import { prisma } from '@/lib/prisma/client';
import { BadRequestError, NotFoundError } from '@/utils/error';

vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    contactList: {
      findUnique: vi.fn(),
    },
    contact: {
      count:    vi.fn(),
      findMany: vi.fn(),
    },
    contactListMembership: {
      count:    vi.fn(),
      findMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
  },
}));

const mockedPrisma = vi.mocked(prisma, { deep: true });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildDynamicContactWhere', () => {
  it('merges the base send-pipeline eligibility filter with the supplied filterCriteria', () => {
    const where = buildDynamicContactWhere({ role: 'engineer' });

    expect(where).toEqual({
      AND: [
        expect.objectContaining({
          deletedAt:     null,
          suppressedAt:  null,
          consentStatus: { not: 'REVOKED' },
        }),
        { role: 'engineer' },
      ],
    });
  });

  it('passes through arbitrary nested relation filters unchanged (the previewDynamic bug scenario)', () => {
    const nestedFilter = { company: { regulatorMix: { has: 'CBK' } } };
    const where = buildDynamicContactWhere(nestedFilter);

    expect((where as { AND: unknown[] }).AND[1]).toEqual(nestedFilter);
  });

  it('passes through tags-based filters unchanged', () => {
    const tagsFilter = { tags: { hasSome: ['SACCO', 'PSP'] } };
    const where = buildDynamicContactWhere(tagsFilter);

    expect((where as { AND: unknown[] }).AND[1]).toEqual(tagsFilter);
  });
});

describe('resolveContacts', () => {
  it('throws NotFoundError when the list does not exist', async () => {
    mockedPrisma.contactList.findUnique.mockResolvedValue(null);

    await expect(resolveContacts('missing_list')).rejects.toThrow(NotFoundError);
  });

  it('throws NotFoundError when the list is soft-deleted', async () => {
    mockedPrisma.contactList.findUnique.mockResolvedValue({
      id: 'list_1', name: 'Old', isDynamic: false, filterCriteria: null, deletedAt: new Date(),
    } as never);

    await expect(resolveContacts('list_1')).rejects.toThrow(NotFoundError);
  });

  it('dynamic list: resolves using buildDynamicContactWhere-shaped filter, including nested relation criteria', async () => {
    const storedFilter = { company: { regulatorMix: { has: 'CBK' } } };
    mockedPrisma.contactList.findUnique.mockResolvedValue({
      id: 'list_1', name: 'CBK list', isDynamic: true, filterCriteria: storedFilter, deletedAt: null,
    } as never);
    mockedPrisma.contact.count.mockResolvedValue(2);
    mockedPrisma.contact.findMany.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }] as never);

    const result = await resolveContacts('list_1');

    expect(result).toHaveLength(2);
    const countArg = mockedPrisma.contact.count.mock.calls[0]![0] as { where: { AND: unknown[] } };
    const findManyArg = mockedPrisma.contact.findMany.mock.calls[0]![0] as { where: { AND: unknown[] } };
    expect(countArg.where).toEqual(buildDynamicContactWhere(storedFilter));
    expect(findManyArg.where).toEqual(buildDynamicContactWhere(storedFilter));
  });

  it('dynamic list: throws BadRequestError and never fetches rows when the count exceeds the cap', async () => {
    mockedPrisma.contactList.findUnique.mockResolvedValue({
      id: 'list_1', name: 'Huge list', isDynamic: true, filterCriteria: {}, deletedAt: null,
    } as never);
    mockedPrisma.contact.count.mockResolvedValue(5001);

    await expect(resolveContacts('list_1')).rejects.toThrow(BadRequestError);
    expect(mockedPrisma.contact.findMany).not.toHaveBeenCalled();
  });

  it('static list: applies the base eligibility filter to membership.contact and returns resolved contacts', async () => {
    mockedPrisma.contactList.findUnique.mockResolvedValue({
      id: 'list_2', name: 'Static list', isDynamic: false, filterCriteria: null, deletedAt: null,
    } as never);
    mockedPrisma.contactListMembership.count.mockResolvedValue(1);
    mockedPrisma.contactListMembership.findMany.mockResolvedValue([
      { contact: { id: 'c1', suppressedAt: null } },
    ] as never);

    const result = await resolveContacts('list_2');

    expect(result).toEqual([{ id: 'c1', suppressedAt: null }]);
    const countArg = mockedPrisma.contactListMembership.count.mock.calls[0]![0] as {
      where: { listId: string; contact: Record<string, unknown> };
    };
    expect(countArg.where.contact).toEqual(
      expect.objectContaining({ deletedAt: null, suppressedAt: null, consentStatus: { not: 'REVOKED' } }),
    );
  });

  it('static list: throws BadRequestError when membership count exceeds the cap', async () => {
    mockedPrisma.contactList.findUnique.mockResolvedValue({
      id: 'list_2', name: 'Huge static list', isDynamic: false, filterCriteria: null, deletedAt: null,
    } as never);
    mockedPrisma.contactListMembership.count.mockResolvedValue(5001);

    await expect(resolveContacts('list_2')).rejects.toThrow(BadRequestError);
    expect(mockedPrisma.contactListMembership.findMany).not.toHaveBeenCalled();
  });
});
