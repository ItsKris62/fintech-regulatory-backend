import { TRPCError } from '@trpc/server';
import { ContentStatus, ContentType, DocumentStatus } from '@prisma/client';

type PrismaLike = {
  legalDocument: {
    findMany(args: unknown): Promise<LegalBenchmarkRow[]>;
  };
  regulatoryDocument?: {
    findMany(args: unknown): Promise<RegulatoryBenchmarkRow[]>;
  };
};

type LegalBenchmarkRow = {
  id: string;
  title: string | null;
  actName: string;
  documentType: string;
  regulatoryBody: string | null;
  category: string | null;
  subcategory: string | null;
  tags: string[];
  contentStatus: ContentStatus;
  status: DocumentStatus;
  organizationId: string | null;
  userId: string | null;
  version: number;
  updatedAt: Date;
};

type RegulatoryBenchmarkRow = {
  id: string;
  title: string;
  source: string;
  category: string;
  documentType: string;
  authorityStatus: string;
  version: string | null;
  officialUrl: string | null;
  effectiveDate: Date | null;
  effectiveEndDate: Date | null;
  isBinding: boolean;
  indexVersion: string;
  sourceDocumentVersionId: string | null;
  status: string;
  updatedAt: Date;
};

export type AuthorizedBenchmarkDocument = {
  id: string;
  title: string;
  source: string | null;
  frameworkSlug: string | null;
  documentType: string;
  authorityStatus: string | null;
  version: string | null;
  officialUrl: string | null;
  effectiveDate: Date | null;
  effectiveEndDate: Date | null;
  isBinding: boolean | null;
  indexVersion: string | null;
  sourceDocumentVersionId: string | null;
  sourceStatus: string | null;
  organizationId: string | null;
  isGlobal: boolean;
  updatedAt: Date;
  regulatoryBody: string | null;
};

export function buildAuthorizedLegalBenchmarkWhere(input: {
  userId: string;
  organizationId: string;
}) {
  return {
    deletedAt: null,
    contentType: ContentType.REGULATORY_DOCUMENT,
    status: DocumentStatus.INDEXED,
    OR: [
      {
        organizationId: null,
        contentStatus: ContentStatus.PUBLISHED,
      },
      {
        organizationId: input.organizationId,
      },
      {
        userId: input.userId,
      },
    ],
  };
}

export function buildAuthorizedRegulatoryBenchmarkWhere() {
  return {
    status: 'ACTIVE',
  };
}

function normalizeLegalDocument(doc: LegalBenchmarkRow): AuthorizedBenchmarkDocument {
  return {
    id: doc.id,
    title: doc.title ?? doc.actName,
    source: doc.regulatoryBody,
    frameworkSlug: doc.category,
    documentType: doc.documentType,
    authorityStatus: null,
    version: String(doc.version),
    officialUrl: null,
    effectiveDate: null,
    effectiveEndDate: null,
    isBinding: null,
    indexVersion: null,
    sourceDocumentVersionId: null,
    sourceStatus: null,
    organizationId: doc.organizationId,
    isGlobal: doc.organizationId === null,
    updatedAt: doc.updatedAt,
    regulatoryBody: doc.regulatoryBody,
  };
}

function normalizeRegulatoryDocument(doc: RegulatoryBenchmarkRow): AuthorizedBenchmarkDocument {
  return {
    id: doc.id,
    title: doc.title,
    source: doc.source,
    frameworkSlug: doc.category,
    documentType: doc.documentType,
    authorityStatus: doc.authorityStatus,
    version: doc.version,
    officialUrl: doc.officialUrl,
    effectiveDate: doc.effectiveDate,
    effectiveEndDate: doc.effectiveEndDate,
    isBinding: doc.isBinding,
    indexVersion: doc.indexVersion,
    sourceDocumentVersionId: doc.sourceDocumentVersionId,
    sourceStatus: doc.status,
    organizationId: null,
    isGlobal: true,
    updatedAt: doc.updatedAt,
    regulatoryBody: doc.source,
  };
}

export async function listAuthorizedBenchmarkDocuments(input: {
  prisma: PrismaLike;
  userId: string;
  organizationId: string;
  search?: string | null;
}): Promise<AuthorizedBenchmarkDocument[]> {
  const search = input.search?.trim();

  const legalWhere: Record<string, unknown> = buildAuthorizedLegalBenchmarkWhere(input);
  if (search) {
    legalWhere.AND = [
      ...(Array.isArray(legalWhere.AND) ? legalWhere.AND : []),
      {
        OR: [
          { title: { contains: search, mode: 'insensitive' } },
          { actName: { contains: search, mode: 'insensitive' } },
          { regulatoryBody: { contains: search, mode: 'insensitive' } },
        ],
      },
    ];
  }

  const regulatoryWhere: Record<string, unknown> = buildAuthorizedRegulatoryBenchmarkWhere();
  if (search) {
    regulatoryWhere.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { source: { contains: search, mode: 'insensitive' } },
      { documentType: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [legalDocs, regulatoryDocs] = await Promise.all([
    input.prisma.legalDocument.findMany({
      where: legalWhere,
      orderBy: [{ organizationId: 'asc' }, { updatedAt: 'desc' }],
      select: {
        id: true,
        title: true,
        actName: true,
        documentType: true,
        regulatoryBody: true,
        category: true,
        subcategory: true,
        tags: true,
        contentStatus: true,
        status: true,
        organizationId: true,
        userId: true,
        version: true,
        updatedAt: true,
      },
    }),
    input.prisma.regulatoryDocument?.findMany({
      where: regulatoryWhere,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        title: true,
        source: true,
        category: true,
        documentType: true,
        authorityStatus: true,
        version: true,
        officialUrl: true,
        effectiveDate: true,
        effectiveEndDate: true,
        isBinding: true,
        indexVersion: true,
        sourceDocumentVersionId: true,
        status: true,
        updatedAt: true,
      },
    }).catch(() => []) ?? Promise.resolve([]),
  ]);

  const byId = new Map<string, AuthorizedBenchmarkDocument>();
  for (const doc of regulatoryDocs) byId.set(doc.id, normalizeRegulatoryDocument(doc));
  for (const doc of legalDocs) byId.set(doc.id, normalizeLegalDocument(doc));

  return Array.from(byId.values()).sort((a, b) => {
    if (a.isGlobal !== b.isGlobal) return a.isGlobal ? -1 : 1;
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });
}

export async function validateAuthorizedBenchmarkDocumentIds(input: {
  prisma: PrismaLike;
  userId: string;
  organizationId: string;
  benchmarkDocumentIds: string[];
}): Promise<AuthorizedBenchmarkDocument[]> {
  const uniqueIds = [...new Set(input.benchmarkDocumentIds)];
  if (uniqueIds.length === 0) return [];

  const authorized = await listAuthorizedBenchmarkDocuments(input);
  const byId = new Map(authorized.map((doc) => [doc.id, doc]));
  const selected = uniqueIds.map((id) => byId.get(id)).filter((doc): doc is AuthorizedBenchmarkDocument => !!doc);

  if (selected.length !== uniqueIds.length) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'One or more benchmark documents are unavailable for this organization.',
    });
  }

  return selected;
}
