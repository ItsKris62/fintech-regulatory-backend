import { ContentStatus, ContentType, DocumentStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizedLegalBenchmarkWhere,
  listAuthorizedBenchmarkDocuments,
  validateAuthorizedBenchmarkDocumentIds,
} from './benchmark-document.service';

const updatedAt = new Date('2026-01-01T00:00:00.000Z');

function prismaMock(input: {
  legalDocs?: any[];
  regulatoryDocs?: any[];
}) {
  return {
    legalDocument: {
      findMany: vi.fn().mockResolvedValue(input.legalDocs ?? []),
    },
    regulatoryDocument: {
      findMany: vi.fn().mockResolvedValue(input.regulatoryDocs ?? []),
    },
  };
}

describe('benchmark document authorization service', () => {
  it('builds a DB-level scope for published global documents, organization documents, and user documents', () => {
    expect(buildAuthorizedLegalBenchmarkWhere({
      userId: 'user_1',
      organizationId: 'org_1',
    })).toEqual({
      deletedAt: null,
      contentType: ContentType.REGULATORY_DOCUMENT,
      status: DocumentStatus.INDEXED,
      OR: [
        {
          organizationId: null,
          contentStatus: ContentStatus.PUBLISHED,
        },
        {
          organizationId: 'org_1',
        },
        {
          userId: 'user_1',
        },
      ],
    });
  });

  it('lists active platform corpus documents and indexed organization legal documents as benchmark options', async () => {
    const prisma = prismaMock({
      regulatoryDocs: [{
        id: 'global_reg_doc',
        title: 'Data Protection Act 2019',
        source: 'ODPC',
        category: 'dpa_2019',
        documentType: 'ACT',
        authorityStatus: 'IN_FORCE',
        version: '2019',
        updatedAt,
      }],
      legalDocs: [{
        id: 'org_legal_doc',
        title: 'Internal AML Benchmark',
        actName: 'Internal AML Benchmark.pdf',
        documentType: 'GUIDELINE',
        regulatoryBody: 'CBK',
        category: 'aml',
        subcategory: null,
        tags: [],
        contentStatus: ContentStatus.PUBLISHED,
        status: DocumentStatus.INDEXED,
        organizationId: 'org_1',
        userId: 'user_1',
        version: 3,
        updatedAt,
      }],
    });

    const documents = await listAuthorizedBenchmarkDocuments({
      prisma: prisma as any,
      userId: 'user_1',
      organizationId: 'org_1',
    });

    expect(documents).toEqual([
      expect.objectContaining({
        id: 'global_reg_doc',
        title: 'Data Protection Act 2019',
        isGlobal: true,
        source: 'ODPC',
        frameworkSlug: 'dpa_2019',
      }),
      expect.objectContaining({
        id: 'org_legal_doc',
        title: 'Internal AML Benchmark',
        isGlobal: false,
        source: 'CBK',
        frameworkSlug: 'aml',
      }),
    ]);
  });

  it('validates only documents visible to the current organization and user', async () => {
    const prisma = prismaMock({
      regulatoryDocs: [{
        id: 'global_reg_doc',
        title: 'Data Protection Act 2019',
        source: 'ODPC',
        category: 'dpa_2019',
        documentType: 'ACT',
        authorityStatus: 'IN_FORCE',
        version: '2019',
        updatedAt,
      }],
      legalDocs: [],
    });

    await expect(validateAuthorizedBenchmarkDocumentIds({
      prisma: prisma as any,
      userId: 'user_1',
      organizationId: 'org_1',
      benchmarkDocumentIds: ['global_reg_doc'],
    })).resolves.toEqual([
      expect.objectContaining({ id: 'global_reg_doc' }),
    ]);
  });

  it('rejects unavailable benchmark IDs without leaking which ID failed', async () => {
    const prisma = prismaMock({
      regulatoryDocs: [],
      legalDocs: [],
    });

    await expect(validateAuthorizedBenchmarkDocumentIds({
      prisma: prisma as any,
      userId: 'user_1',
      organizationId: 'org_1',
      benchmarkDocumentIds: ['other_org_secret_doc'],
    })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'One or more benchmark documents are unavailable for this organization.',
    });
  });
});
