/**
 * Company Service (P0 Enhanced)
 *
 * CRUD operations for marketing Company records, lead qualification state
 * transitions, soft-delete, and audit logging.
 */

import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { NotFoundError } from '@/utils/error';
import {
  CompanyOrigin,
  LeadStatus,
  SalesStage,
  IcpTier,
  CompanySizeClass,
  EvidenceVerificationState,
  Prisma,
} from '@prisma/client';
import { normalizeDomain } from './company-dedup.service';
import { computeEvidenceHash } from './lead-qualification.service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PUBLIC_EMAIL_PROVIDERS = new Set([
  'gmail.com', 'outlook.com', 'yahoo.com', 'hotmail.com',
  'icloud.com', 'protonmail.com', 'proton.me',
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateCompanyParams {
  name: string;
  domain?: string | null;
  industry?: string | null;
  regulatorMix?: string[];
  notes?: string | null;
  origin?: CompanyOrigin;
  leadStatus?: LeadStatus;
  salesStage?: SalesStage;
  icpTier?: IcpTier;
  leadScore?: number | null;
  sizeClass?: CompanySizeClass;
  country?: string;
  regulatoryBody?: string | null;
  licenceType?: string | null;
  licenceNumber?: string | null;
  licenceStatus?: string | null;
  primarySourceUrl?: string | null;
  primarySourceAuthority?: string | null;
  discoveredAt?: Date | null;
  lastVerifiedAt?: Date | null;
  confidence?: number | null;
  ownerId?: string | null;
}

export interface UpdateCompanyParams {
  name?: string;
  domain?: string | null;
  industry?: string | null;
  regulatorMix?: string[];
  notes?: string | null;
  leadStatus?: LeadStatus;
  salesStage?: SalesStage;
  icpTier?: IcpTier;
  leadScore?: number | null;
  sizeClass?: CompanySizeClass;
  country?: string;
  regulatoryBody?: string | null;
  licenceType?: string | null;
  licenceNumber?: string | null;
  licenceStatus?: string | null;
  primarySourceUrl?: string | null;
  primarySourceAuthority?: string | null;
  lastVerifiedAt?: Date | null;
  confidence?: number | null;
  ownerId?: string | null;
  reviewedById?: string | null;
  reviewedAt?: Date | null;
  reviewReason?: string | null;
  rejectionReason?: string | null;
}

export interface ListCompaniesParams {
  query?: string;
  leadStatus?: LeadStatus;
  icpTier?: IcpTier;
  salesStage?: SalesStage;
  origin?: CompanyOrigin;
  country?: string;
  minScore?: number;
  maxScore?: number;
  take?: number;
  skip?: number;
  orderBy?: 'name' | 'leadScore' | 'createdAt' | 'updatedAt';
  orderDir?: 'asc' | 'desc';
}

export interface IngestEvidenceParams {
  companyId: string;
  discoveryRunId?: string | null;
  field: string;
  extractedValue: string;
  normalizedValue?: string | null;
  confidence?: number;
  sourceUrl: string;
  sourceAuthority?: string | null;
  sourceRecordId?: string | null;
  evidenceSnippet?: string | null;
  verificationState?: EvidenceVerificationState;
  extractionMethod?: string | null;
  modelProvider?: string | null;
  modelName?: string | null;
  extractorVersion?: string | null;
}

// ---------------------------------------------------------------------------
// Audit log helper (non-fatal)
// ---------------------------------------------------------------------------

async function writeAuditLog(
  userId: string,
  action: string,
  entityType: string,
  entityId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: { userId, action, entityType, entityId, metadata: metadata as object },
    });
  } catch (err: unknown) {
    logger.error({
      type: 'audit_log_write_failed',
      action,
      entityId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function createCompany(
  params: CreateCompanyParams,
  userId: string,
) {
  const normDomain = normalizeDomain(params.domain);

  const company = await prisma.company.create({
    data: {
      name:                   params.name.trim(),
      domain:                 normDomain,
      industry:               params.industry?.trim() || null,
      regulatorMix:           params.regulatorMix ?? [],
      notes:                  params.notes?.trim() || null,
      origin:                 params.origin ?? CompanyOrigin.MANUAL_CRM,
      leadStatus:             params.leadStatus ?? LeadStatus.UNASSESSED,
      salesStage:             params.salesStage ?? SalesStage.PROSPECT,
      icpTier:                params.icpTier ?? IcpTier.UNASSESSED,
      leadScore:              params.leadScore ?? null,
      sizeClass:              params.sizeClass ?? CompanySizeClass.UNKNOWN,
      country:                params.country?.trim() || 'Kenya',
      regulatoryBody:         params.regulatoryBody?.trim() || null,
      licenceType:            params.licenceType?.trim() || null,
      licenceNumber:          params.licenceNumber?.trim() || null,
      licenceStatus:          params.licenceStatus?.trim() || null,
      primarySourceUrl:       params.primarySourceUrl?.trim() || null,
      primarySourceAuthority: params.primarySourceAuthority?.trim() || null,
      discoveredAt:           params.discoveredAt ?? null,
      lastVerifiedAt:         params.lastVerifiedAt ?? null,
      confidence:             params.confidence ?? null,
      ownerId:                params.ownerId || null,
      createdById:            userId,
    },
  });

  await writeAuditLog(userId, 'MARKETING_COMPANY_CREATED', 'Company', company.id, {
    name: company.name,
    origin: company.origin,
  });

  logger.info({ type: 'marketing_company_created', companyId: company.id });
  return company;
}

export async function updateCompany(
  id: string,
  params: UpdateCompanyParams,
  userId: string,
) {
  const existing = await prisma.company.findUnique({
    where: { id },
    select: { id: true, deletedAt: true },
  });
  if (!existing || existing.deletedAt) throw new NotFoundError('Company not found');

  const normDomain = params.domain !== undefined ? normalizeDomain(params.domain) : undefined;

  const company = await prisma.company.update({
    where: { id },
    data: {
      ...(params.name                   !== undefined ? { name:                   params.name.trim() } : {}),
      ...(params.domain                 !== undefined ? { domain:                 normDomain } : {}),
      ...(params.industry               !== undefined ? { industry:               params.industry?.trim() || null } : {}),
      ...(params.regulatorMix           !== undefined ? { regulatorMix:           params.regulatorMix } : {}),
      ...(params.notes                  !== undefined ? { notes:                  params.notes?.trim() || null } : {}),
      ...(params.leadStatus             !== undefined ? { leadStatus:             params.leadStatus } : {}),
      ...(params.salesStage             !== undefined ? { salesStage:             params.salesStage } : {}),
      ...(params.icpTier                !== undefined ? { icpTier:                params.icpTier } : {}),
      ...(params.leadScore              !== undefined ? { leadScore:              params.leadScore } : {}),
      ...(params.sizeClass              !== undefined ? { sizeClass:              params.sizeClass } : {}),
      ...(params.country                !== undefined ? { country:                params.country.trim() } : {}),
      ...(params.regulatoryBody         !== undefined ? { regulatoryBody:         params.regulatoryBody?.trim() || null } : {}),
      ...(params.licenceType            !== undefined ? { licenceType:            params.licenceType?.trim() || null } : {}),
      ...(params.licenceNumber          !== undefined ? { licenceNumber:          params.licenceNumber?.trim() || null } : {}),
      ...(params.licenceStatus          !== undefined ? { licenceStatus:          params.licenceStatus?.trim() || null } : {}),
      ...(params.primarySourceUrl       !== undefined ? { primarySourceUrl:       params.primarySourceUrl?.trim() || null } : {}),
      ...(params.primarySourceAuthority !== undefined ? { primarySourceAuthority: params.primarySourceAuthority?.trim() || null } : {}),
      ...(params.lastVerifiedAt         !== undefined ? { lastVerifiedAt:         params.lastVerifiedAt } : {}),
      ...(params.confidence             !== undefined ? { confidence:             params.confidence } : {}),
      ...(params.ownerId                !== undefined ? { ownerId:                params.ownerId } : {}),
      ...(params.reviewedById           !== undefined ? { reviewedById:           params.reviewedById } : {}),
      ...(params.reviewedAt             !== undefined ? { reviewedAt:             params.reviewedAt } : {}),
      ...(params.reviewReason           !== undefined ? { reviewReason:           params.reviewReason?.trim() || null } : {}),
      ...(params.rejectionReason        !== undefined ? { rejectionReason:        params.rejectionReason?.trim() || null } : {}),
    },
  });

  await writeAuditLog(userId, 'MARKETING_COMPANY_UPDATED', 'Company', id, { updated: params });
  logger.info({ type: 'marketing_company_updated', companyId: id });
  return company;
}

export async function deleteCompany(id: string, userId: string): Promise<void> {
  const existing = await prisma.company.findUnique({
    where: { id },
    select: { id: true, deletedAt: true },
  });
  if (!existing || existing.deletedAt) throw new NotFoundError('Company not found');

  await prisma.company.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  await writeAuditLog(userId, 'MARKETING_COMPANY_DELETED', 'Company', id);
  logger.info({ type: 'marketing_company_deleted', companyId: id });
}

export async function getCompany(id: string) {
  const company = await prisma.company.findUnique({
    where: { id },
    include: {
      contacts: {
        where: { deletedAt: null },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          phone: true,
          linkedinUrl: true,
          salesStage: true,
          consentStatus: true,
          createdAt: true,
        },
      },
      evidence: {
        orderBy: { createdAt: 'desc' },
      },
      owner: {
        select: { id: true, fullName: true, email: true },
      },
      reviewedBy: {
        select: { id: true, fullName: true, email: true },
      },
      discoveryRuns: {
        include: {
          discoveryRun: {
            select: { id: true, workflowName: true, sourceAuthority: true, startedAt: true },
          },
        },
      },
      _count: {
        select: { contacts: true, evidence: true },
      },
    },
  });

  if (!company || company.deletedAt) throw new NotFoundError('Company not found');
  return company;
}

export async function listCompanies(params: ListCompaniesParams = {}) {
  const {
    query,
    leadStatus,
    icpTier,
    salesStage,
    origin,
    country,
    minScore,
    maxScore,
    take = 50,
    skip = 0,
    orderBy = 'createdAt',
    orderDir = 'desc',
  } = params;

  const where: Prisma.CompanyWhereInput = {
    deletedAt: null,
    ...(query
      ? {
          OR: [
            { name: { contains: query.trim(), mode: 'insensitive' } },
            { domain: { contains: query.trim(), mode: 'insensitive' } },
            { licenceNumber: { contains: query.trim(), mode: 'insensitive' } },
          ],
        }
      : {}),
    ...(leadStatus ? { leadStatus } : {}),
    ...(icpTier ? { icpTier } : {}),
    ...(salesStage ? { salesStage } : {}),
    ...(origin ? { origin } : {}),
    ...(country ? { country: { equals: country.trim(), mode: 'insensitive' } } : {}),
    ...(minScore !== undefined || maxScore !== undefined
      ? {
          leadScore: {
            ...(minScore !== undefined ? { gte: minScore } : {}),
            ...(maxScore !== undefined ? { lte: maxScore } : {}),
          },
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.company.findMany({
      where,
      orderBy: { [orderBy]: orderDir },
      take,
      skip,
      include: {
        owner: { select: { id: true, fullName: true, email: true } },
        reviewedBy: { select: { id: true, fullName: true, email: true } },
        _count: { select: { contacts: true, evidence: true } },
      },
    }),
    prisma.company.count({ where }),
  ]);

  return { items, total };
}

/**
 * Persists an evidence record idempotently with SHA-256 hash duplicate protection.
 */
export async function ingestDiscoveryEvidence(params: IngestEvidenceParams) {
  const evidenceHash = computeEvidenceHash({
    companyIdentifier: params.companyId,
    field: params.field,
    normalizedValue: params.normalizedValue || params.extractedValue,
    sourceUrl: params.sourceUrl,
    sourceRecordId: params.sourceRecordId,
  });

  return prisma.discoveryEvidence.upsert({
    where: {
      companyId_evidenceHash: {
        companyId: params.companyId,
        evidenceHash,
      },
    },
    create: {
      companyId:         params.companyId,
      discoveryRunId:    params.discoveryRunId || null,
      field:             params.field,
      extractedValue:    params.extractedValue,
      normalizedValue:   params.normalizedValue || null,
      confidence:        params.confidence ?? 1.0,
      sourceUrl:         params.sourceUrl,
      sourceAuthority:   params.sourceAuthority || null,
      sourceRecordId:    params.sourceRecordId || null,
      evidenceSnippet:   params.evidenceSnippet || null,
      verificationState: params.verificationState ?? EvidenceVerificationState.UNVERIFIED,
      evidenceHash,
      extractionMethod:  params.extractionMethod || 'AI_SCRAPE',
      modelProvider:     params.modelProvider || null,
      modelName:         params.modelName || null,
      extractorVersion:  params.extractorVersion || null,
    },
    update: {
      extractedValue:    params.extractedValue,
      normalizedValue:   params.normalizedValue || null,
      confidence:        params.confidence ?? 1.0,
      evidenceSnippet:   params.evidenceSnippet || null,
      verificationState: params.verificationState ?? EvidenceVerificationState.UNVERIFIED,
      modelProvider:     params.modelProvider || null,
      modelName:         params.modelName || null,
      extractorVersion:  params.extractorVersion || null,
      updatedAt:         new Date(),
    },
  });
}

/**
 * For CSV import: resolve or create a Company record using the contact's email
 * domain and optional company name.
 */
export async function findOrCreateByEmailDomain(
  email: string,
  companyName: string,
  userId: string,
): Promise<string | null> {
  const domain = email.split('@')[1]?.toLowerCase().trim() ?? '';

  if (!domain || PUBLIC_EMAIL_PROVIDERS.has(domain)) return null;

  const name = companyName.trim();
  if (!name) return null;

  // 1. Find by name (case-insensitive)
  const byName = await prisma.company.findFirst({
    where: { name: { equals: name, mode: 'insensitive' }, deletedAt: null },
    select: { id: true },
  });
  if (byName) return byName.id;

  // 2. Find by domain
  const byDomain = await prisma.company.findFirst({
    where: { domain, deletedAt: null },
    select: { id: true },
  });
  if (byDomain) return byDomain.id;

  // 3. Create (legacy/import origin: MANUAL_CRM, UNASSESSED)
  const company = await prisma.company.create({
    data: {
      name,
      domain,
      origin: CompanyOrigin.CONTACT_IMPORT,
      leadStatus: LeadStatus.UNASSESSED,
      createdById: userId,
    },
    select: { id: true },
  });

  await writeAuditLog(userId, 'MARKETING_COMPANY_CREATED', 'Company', company.id, {
    name,
    domain,
    source: 'csv_import',
  });

  return company.id;
}
