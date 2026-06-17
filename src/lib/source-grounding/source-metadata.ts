import crypto from 'crypto';

export type PageSpan = {
  pageStart?: number | null;
  pageEnd?: number | null;
};

export type HeadingPath = string[];

export type ProvisionAnchor = {
  sectionNumber?: string | null;
  clauseNumber?: string | null;
  scheduleNumber?: string | null;
  headingPath?: HeadingPath | null;
  provisionId?: string | null;
};

export type SourceVersionRef = {
  sourceDocumentVersionId?: string | null;
  officialUrl?: string | null;
  publicationDate?: Date | string | null;
  retrievedAt?: Date | string | null;
  effectiveDate?: Date | string | null;
  effectiveEndDate?: Date | string | null;
  versionLabel?: string | null;
  checksumSha256?: string | null;
};

export type V2ChunkMetadata = PageSpan & ProvisionAnchor & SourceVersionRef & {
  documentId: string;
  documentChecksum?: string | null;
  chunkIndex: number;
  charStart?: number | null;
  charEnd?: number | null;
  contentHash: string;
  indexVersion: string;
  authorityStatus?: string | null;
  corpusStatus?: string | null;
  isBinding?: boolean | null;
};

export type SourceLifecycleInput = {
  documentStatus?: string | null;
  versionStatus?: string | null;
  authorityStatus?: string | null;
  effectiveEndDate?: Date | string | null;
  supersededByDocumentId?: string | null;
  isBinding?: boolean | null;
};

function stableJson(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${stableJson(val)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function generateContentHash(content: string): string {
  return crypto.createHash('sha256').update(content.normalize('NFC').trim()).digest('hex');
}

export function normalizeOfficialUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = '';
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/');
    if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function hostnameMatchesAllowedDomain(hostname: string, allowedDomain: string): boolean {
  const host = hostname.toLowerCase();
  const allowed = allowedDomain.toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  return host === allowed || host.endsWith(`.${allowed}`);
}

export function isOfficialUrlAllowed(
  officialUrl: string | null | undefined,
  approvedSource: { baseUrl?: string | null; allowedDomains?: unknown } | null | undefined,
): boolean {
  const normalized = officialUrl ? normalizeOfficialUrl(officialUrl) : null;
  if (!normalized || !approvedSource) return false;

  const hostname = new URL(normalized).hostname;
  const domains = Array.isArray(approvedSource.allowedDomains)
    ? approvedSource.allowedDomains.filter((domain): domain is string => typeof domain === 'string')
    : [];

  const base = approvedSource.baseUrl ? normalizeOfficialUrl(approvedSource.baseUrl) : null;
  if (base) domains.push(new URL(base).hostname);

  return domains.some((domain) => hostnameMatchesAllowedDomain(hostname, domain));
}

export function generateProvisionId(input: {
  documentId: string;
  chunkIndex?: number | null;
  pageStart?: number | null;
  pageEnd?: number | null;
  sectionNumber?: string | null;
  clauseNumber?: string | null;
  scheduleNumber?: string | null;
  headingPath?: HeadingPath | null;
}): string {
  const payload = {
    documentId: input.documentId,
    chunkIndex: input.chunkIndex ?? null,
    pageStart: input.pageStart ?? null,
    pageEnd: input.pageEnd ?? null,
    sectionNumber: input.sectionNumber?.trim() || null,
    clauseNumber: input.clauseNumber?.trim() || null,
    scheduleNumber: input.scheduleNumber?.trim() || null,
    headingPath: input.headingPath ?? null,
  };
  return crypto.createHash('sha256').update(stableJson(payload)).digest('hex').slice(0, 32);
}

export function deriveSourceLifecycleStatus(input: SourceLifecycleInput): {
  corpusStatus: 'ACTIVE' | 'SUPERSEDED' | 'ARCHIVED' | 'DRAFT' | 'CONSULTATION';
  isCurrent: boolean;
  isBinding: boolean;
} {
  const now = Date.now();
  const end = input.effectiveEndDate ? new Date(input.effectiveEndDate).getTime() : null;
  const authorityStatus = input.authorityStatus ?? 'IN_FORCE';

  if (input.documentStatus === 'SUPERSEDED' || input.versionStatus === 'SUPERSEDED' || input.supersededByDocumentId || authorityStatus === 'SUPERSEDED') {
    return { corpusStatus: 'SUPERSEDED', isCurrent: false, isBinding: false };
  }
  if (input.versionStatus === 'ARCHIVED') {
    return { corpusStatus: 'ARCHIVED', isCurrent: false, isBinding: false };
  }
  if (authorityStatus === 'DRAFT' || input.versionStatus === 'DRAFT') {
    return { corpusStatus: 'DRAFT', isCurrent: false, isBinding: false };
  }
  if (authorityStatus === 'CONSULTATION' || input.versionStatus === 'CONSULTATION') {
    return { corpusStatus: 'CONSULTATION', isCurrent: false, isBinding: false };
  }
  if (end && end <= now) {
    return { corpusStatus: 'SUPERSEDED', isCurrent: false, isBinding: false };
  }
  return { corpusStatus: 'ACTIVE', isCurrent: true, isBinding: input.isBinding ?? authorityStatus === 'IN_FORCE' };
}

export function mapV1DocumentToV2Metadata(doc: {
  id: string;
  checksum?: string | null;
  effectiveDate?: Date | string | null;
  effectiveEndDate?: Date | string | null;
  version?: string | null;
  authorityStatus?: string | null;
  isBinding?: boolean | null;
  status?: string | null;
  sourceDocumentVersionId?: string | null;
  officialUrl?: string | null;
}): SourceVersionRef & {
  documentChecksum?: string | null;
  authorityStatus?: string | null;
  corpusStatus: string;
  isBinding: boolean;
  indexVersion: string;
} {
  const lifecycle = deriveSourceLifecycleStatus({
    documentStatus: doc.status,
    authorityStatus: doc.authorityStatus,
    effectiveEndDate: doc.effectiveEndDate,
    isBinding: doc.isBinding,
  });

  return {
    sourceDocumentVersionId: doc.sourceDocumentVersionId ?? null,
    officialUrl: doc.officialUrl ?? null,
    effectiveDate: doc.effectiveDate ?? null,
    effectiveEndDate: doc.effectiveEndDate ?? null,
    versionLabel: doc.version ?? null,
    checksumSha256: doc.checksum ?? null,
    documentChecksum: doc.checksum ?? null,
    authorityStatus: doc.authorityStatus ?? 'IN_FORCE',
    corpusStatus: lifecycle.corpusStatus,
    isBinding: lifecycle.isBinding,
    indexVersion: 'v1',
  };
}

export function prepareV2ChunkMetadata(input: {
  documentId: string;
  chunkIndex: number;
  content: string;
  documentChecksum?: string | null;
  pageSpan?: PageSpan | null;
  provisionAnchor?: ProvisionAnchor | null;
  sourceVersion?: SourceVersionRef | null;
  charStart?: number | null;
  charEnd?: number | null;
  authorityStatus?: string | null;
  corpusStatus?: string | null;
  isBinding?: boolean | null;
  indexVersion?: string | null;
}): V2ChunkMetadata {
  const pageSpan = input.pageSpan ?? {};
  const provisionAnchor = input.provisionAnchor ?? {};
  const provisionId = provisionAnchor.provisionId ?? generateProvisionId({
    documentId: input.documentId,
    chunkIndex: input.chunkIndex,
    pageStart: pageSpan.pageStart,
    pageEnd: pageSpan.pageEnd,
    sectionNumber: provisionAnchor.sectionNumber,
    clauseNumber: provisionAnchor.clauseNumber,
    scheduleNumber: provisionAnchor.scheduleNumber,
    headingPath: provisionAnchor.headingPath,
  });

  return {
    documentId: input.documentId,
    documentChecksum: input.documentChecksum ?? null,
    chunkIndex: input.chunkIndex,
    pageStart: pageSpan.pageStart ?? null,
    pageEnd: pageSpan.pageEnd ?? null,
    sectionNumber: provisionAnchor.sectionNumber ?? null,
    clauseNumber: provisionAnchor.clauseNumber ?? null,
    scheduleNumber: provisionAnchor.scheduleNumber ?? null,
    headingPath: provisionAnchor.headingPath ?? null,
    provisionId,
    charStart: input.charStart ?? null,
    charEnd: input.charEnd ?? null,
    contentHash: generateContentHash(input.content),
    sourceDocumentVersionId: input.sourceVersion?.sourceDocumentVersionId ?? null,
    officialUrl: input.sourceVersion?.officialUrl ?? null,
    publicationDate: input.sourceVersion?.publicationDate ?? null,
    retrievedAt: input.sourceVersion?.retrievedAt ?? null,
    effectiveDate: input.sourceVersion?.effectiveDate ?? null,
    effectiveEndDate: input.sourceVersion?.effectiveEndDate ?? null,
    versionLabel: input.sourceVersion?.versionLabel ?? null,
    checksumSha256: input.sourceVersion?.checksumSha256 ?? null,
    indexVersion: input.indexVersion ?? 'v2',
    authorityStatus: input.authorityStatus ?? null,
    corpusStatus: input.corpusStatus ?? null,
    isBinding: input.isBinding ?? null,
  };
}

export function omitNullishMetadata<T extends Record<string, unknown>>(metadata: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== null && value !== undefined),
  ) as Partial<T>;
}

function fieldEqOrMissing(field: string, value: string | boolean): Record<string, unknown> {
  return {
    $or: [
      { [field]: { $eq: value } },
      { [field]: { $exists: false } },
    ],
  };
}

export function buildPreferredActiveSourceFilter(input: {
  jurisdiction?: string | null;
  baseFilter?: Record<string, unknown> | null;
} = {}): Record<string, unknown> {
  const conditions: Record<string, unknown>[] = [];

  if (input.baseFilter && Object.keys(input.baseFilter).length > 0) {
    conditions.push(input.baseFilter);
  }

  if (input.jurisdiction) {
    conditions.push(fieldEqOrMissing('jurisdiction', input.jurisdiction));
  }

  conditions.push(fieldEqOrMissing('corpusStatus', 'ACTIVE'));
  conditions.push(fieldEqOrMissing('authorityStatus', 'IN_FORCE'));

  return conditions.length === 1 ? conditions[0] : { $and: conditions };
}
