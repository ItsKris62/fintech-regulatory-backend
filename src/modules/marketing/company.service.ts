/**
 * Company Service
 *
 * CRUD operations for marketing Company records plus the import helper
 * `findOrCreateByEmailDomain` used by the CSV contact importer.
 *
 * Soft-delete: companies are never hard-deleted; deletedAt is set instead.
 * All read operations filter deletedAt: null unless explicitly fetching deleted.
 *
 * Audit actions written to AuditLog:
 *   MARKETING_COMPANY_CREATED | MARKETING_COMPANY_UPDATED | MARKETING_COMPANY_DELETED
 */

import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { NotFoundError } from '@/utils/error';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Email providers that should never auto-generate a company record. */
const PUBLIC_EMAIL_PROVIDERS = new Set([
  'gmail.com', 'outlook.com', 'yahoo.com', 'hotmail.com',
  'icloud.com', 'protonmail.com', 'proton.me',
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateCompanyParams {
  name: string;
  domain?: string;
  industry?: string;
  regulatorMix?: string[];
  notes?: string;
}

export interface UpdateCompanyParams {
  name?: string;
  domain?: string;
  industry?: string;
  regulatorMix?: string[];
  notes?: string;
}

export interface ListCompaniesParams {
  query?: string;
  take?: number;
  skip?: number;
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
      type:     'audit_log_write_failed',
      action,
      entityId,
      error:    err instanceof Error ? err.message : String(err),
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
  const company = await prisma.company.create({
    data: {
      name:         params.name.trim(),
      domain:       params.domain?.trim().toLowerCase() || null,
      industry:     params.industry?.trim() || null,
      regulatorMix: params.regulatorMix ?? [],
      notes:        params.notes?.trim() || null,
      createdById:  userId,
    },
  });

  await writeAuditLog(userId, 'MARKETING_COMPANY_CREATED', 'Company', company.id, {
    name: company.name,
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

  const company = await prisma.company.update({
    where: { id },
    data: {
      ...(params.name        !== undefined ? { name:         params.name.trim() }                    : {}),
      ...(params.domain      !== undefined ? { domain:       params.domain.trim().toLowerCase() }    : {}),
      ...(params.industry    !== undefined ? { industry:     params.industry.trim() || null }         : {}),
      ...(params.regulatorMix !== undefined ? { regulatorMix: params.regulatorMix }                  : {}),
      ...(params.notes       !== undefined ? { notes:        params.notes.trim() || null }           : {}),
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
    data:  { deletedAt: new Date() },
  });

  await writeAuditLog(userId, 'MARKETING_COMPANY_DELETED', 'Company', id);
  logger.info({ type: 'marketing_company_deleted', companyId: id });
}

export async function getCompany(id: string) {
  const company = await prisma.company.findUnique({ where: { id } });
  if (!company || company.deletedAt) throw new NotFoundError('Company not found');
  return company;
}

export async function listCompanies(params: ListCompaniesParams = {}) {
  const { query, take = 50, skip = 0 } = params;

  return prisma.company.findMany({
    where: {
      deletedAt: null,
      ...(query
        ? { name: { contains: query.trim(), mode: 'insensitive' } }
        : {}),
    },
    orderBy: { name: 'asc' },
    take,
    skip,
    select: {
      id:          true,
      name:        true,
      domain:      true,
      industry:    true,
      regulatorMix: true,
      createdAt:   true,
      _count:      { select: { contacts: true } },
    },
  });
}

/**
 * For CSV import: resolve or create a Company record using the contact's email
 * domain and optional company name.
 *
 * Returns null if:
 *   - The email domain is a public provider (gmail.com, outlook.com, etc.)
 *   - No companyName is provided (can't name an auto-created record)
 *
 * Lookup order: name (case-insensitive) → domain → create.
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
    where:  { name: { equals: name, mode: 'insensitive' }, deletedAt: null },
    select: { id: true },
  });
  if (byName) return byName.id;

  // 2. Find by domain
  const byDomain = await prisma.company.findFirst({
    where:  { domain, deletedAt: null },
    select: { id: true },
  });
  if (byDomain) return byDomain.id;

  // 3. Create
  const company = await prisma.company.create({
    data:   { name, domain, createdById: userId },
    select: { id: true },
  });

  await writeAuditLog(userId, 'MARKETING_COMPANY_CREATED', 'Company', company.id, {
    name,
    domain,
    source: 'csv_import',
  });

  return company.id;
}
