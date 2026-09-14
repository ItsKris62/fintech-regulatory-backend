/**
 * Company Deduplication & Entity Resolution Service (P0)
 *
 * Implements multi-signal entity resolution across domain, legal name,
 * and regulatory licence number, with safe admin merge capability.
 */

import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { NotFoundError, BadRequestError } from '@/utils/error';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'outlook.com', 'yahoo.com', 'hotmail.com',
  'icloud.com', 'protonmail.com', 'proton.me', 'mail.com',
  'zoho.com', 'aol.com',
]);

const CORPORATE_SUFFIXES = [
  /\b(limited|ltd|plc|llc|inc|incorporated|corp|corporation|co|company|group|holdings|services|solutions|technologies|tech)\b/gi,
  /[.,\/#!$%\^&\*;:{}=\-_`~()]/g,
];

// ---------------------------------------------------------------------------
// Normalization Helpers
// ---------------------------------------------------------------------------

/**
 * Normalizes a URL or domain string into a clean canonical hostname.
 * Strips protocol, www., paths, query parameters, ports, and trailing slashes.
 */
export function normalizeDomain(input?: string | null): string | null {
  if (!input) return null;
  let raw = input.trim().toLowerCase();

  // If input looks like an email, take the domain part
  if (raw.includes('@')) {
    raw = raw.split('@')[1] || '';
  }

  // Strip protocol
  raw = raw.replace(/^(https?:\/\/)/i, '');
  // Strip www.
  raw = raw.replace(/^www\./i, '');
  // Strip trailing path/query
  raw = raw.split('/')[0] || '';
  raw = raw.split('?')[0] || '';
  raw = raw.split('#')[0] || '';
  raw = raw.split(':')[0] || ''; // strip port

  raw = raw.trim();
  if (!raw || PUBLIC_EMAIL_DOMAINS.has(raw)) return null;

  // Validate simple domain structure
  if (!raw.includes('.') || raw.length < 4) return null;

  return raw;
}

/**
 * Normalizes a company legal name for exact matching:
 * Lowercases, strips punctuation, strips common corporate legal suffixes.
 */
export function normalizeCompanyName(name?: string | null): string {
  if (!name) return '';
  let norm = name.trim().toLowerCase();

  for (const regex of CORPORATE_SUFFIXES) {
    norm = norm.replace(regex, ' ');
  }

  // Collapse multiple whitespaces
  return norm.replace(/\s+/g, ' ').trim();
}

/**
 * Normalizes a regulatory licence number (strips hyphens, spaces, slashes, uppercase).
 */
export function normalizeLicenceNumber(licence?: string | null): string {
  if (!licence) return '';
  return licence.replace(/[\s\-_/\\.]/g, '').toUpperCase().trim();
}

// ---------------------------------------------------------------------------
// Entity Resolution Matcher
// ---------------------------------------------------------------------------

export interface MatchCompanyResult {
  matchedCompany: any | null;
  matchType: 'DOMAIN' | 'LICENCE' | 'EXACT_NAME' | null;
  confidence: number;
}

/**
 * Finds an existing non-deleted Company record matching a candidate lead.
 * Resolution Priority:
 *   1. Canonical Domain (Highest confidence: 1.0)
 *   2. Regulatory Licence Number (High confidence: 0.95)
 *   3. Normalized Legal Name within same Country (Confidence: 0.85)
 */
export async function findMatchingCompany(params: {
  name: string;
  domain?: string | null;
  licenceNumber?: string | null;
  country?: string | null;
}): Promise<MatchCompanyResult> {
  const normDom = normalizeDomain(params.domain);
  const normLic = normalizeLicenceNumber(params.licenceNumber);
  const normName = normalizeCompanyName(params.name);
  const country = params.country || 'Kenya';

  // 1. Match by Canonical Domain
  if (normDom) {
    const byDomain = await prisma.company.findFirst({
      where: {
        domain: normDom,
        deletedAt: null,
      },
      include: {
        _count: { select: { contacts: true, evidence: true } },
      },
    });

    if (byDomain) {
      return {
        matchedCompany: byDomain,
        matchType: 'DOMAIN',
        confidence: 1.0,
      };
    }
  }

  // 2. Match by Regulatory Licence Number
  if (normLic) {
    const byLicence = await prisma.company.findFirst({
      where: {
        licenceNumber: { equals: params.licenceNumber?.trim(), mode: 'insensitive' },
        country: { equals: country, mode: 'insensitive' },
        deletedAt: null,
      },
      include: {
        _count: { select: { contacts: true, evidence: true } },
      },
    });

    if (byLicence) {
      return {
        matchedCompany: byLicence,
        matchType: 'LICENCE',
        confidence: 0.95,
      };
    }
  }

  // 3. Match by Normalized Name
  if (normName) {
    const candidates = await prisma.company.findMany({
      where: {
        country: { equals: country, mode: 'insensitive' },
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
        domain: true,
        country: true,
        licenceNumber: true,
        leadStatus: true,
        leadScore: true,
        icpTier: true,
      },
    });

    for (const c of candidates) {
      if (normalizeCompanyName(c.name) === normName) {
        return {
          matchedCompany: c,
          matchType: 'EXACT_NAME',
          confidence: 0.85,
        };
      }
    }
  }

  return {
    matchedCompany: null,
    matchType: null,
    confidence: 0,
  };
}

/**
 * Checks whether a candidate domain or name belongs to an existing paying Organization.
 */
export async function isExistingPayingCustomer(params: {
  domain?: string | null;
  name?: string;
}): Promise<boolean> {
  const normDom = normalizeDomain(params.domain);
  const normName = normalizeCompanyName(params.name);

  if (normDom) {
    const orgByWebsite = await prisma.organization.findFirst({
      where: {
        website: { contains: normDom, mode: 'insensitive' },
      },
      select: { id: true, subscriptionStatus: true },
    });
    if (orgByWebsite) return true;
  }

  if (normName) {
    const orgs = await prisma.organization.findMany({
      select: { id: true, name: true, subscriptionStatus: true },
    });
    for (const org of orgs) {
      if (normalizeCompanyName(org.name) === normName) {
        return true;
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Admin Merge Utility (Amendment 10 & 11)
// ---------------------------------------------------------------------------

export interface MergeCompaniesParams {
  primaryCompanyId: string;
  secondaryCompanyId: string;
  userId: string;
}

export async function mergeCompanies(params: MergeCompaniesParams) {
  const { primaryCompanyId, secondaryCompanyId, userId } = params;

  if (primaryCompanyId === secondaryCompanyId) {
    throw new BadRequestError('Cannot merge a company into itself');
  }

  const primary = await prisma.company.findUnique({
    where: { id: primaryCompanyId },
  });
  if (!primary || primary.deletedAt) {
    throw new NotFoundError('Primary company not found');
  }

  const secondary = await prisma.company.findUnique({
    where: { id: secondaryCompanyId },
    include: {
      contacts: true,
      evidence: true,
      discoveryRuns: true,
    },
  });
  if (!secondary || secondary.deletedAt) {
    throw new NotFoundError('Secondary company not found');
  }

  // Run merge in a transaction
  return prisma.$transaction(async (tx) => {
    // 1. Move Contacts
    await tx.contact.updateMany({
      where: { companyId: secondaryCompanyId },
      data: { companyId: primaryCompanyId },
    });

    // 2. Move Discovery Evidence (ignoring duplicates via hash collision check)
    for (const ev of secondary.evidence) {
      const existing = await tx.discoveryEvidence.findUnique({
        where: {
          companyId_evidenceHash: {
            companyId: primaryCompanyId,
            evidenceHash: ev.evidenceHash,
          },
        },
      });

      if (!existing) {
        await tx.discoveryEvidence.update({
          where: { id: ev.id },
          data: { companyId: primaryCompanyId },
        });
      } else {
        // Evidence already present on primary, delete secondary duplicate evidence
        await tx.discoveryEvidence.delete({ where: { id: ev.id } });
      }
    }

    // 3. Move DiscoveryRun join records
    for (const runJoin of secondary.discoveryRuns) {
      const existingRunJoin = await tx.discoveryRunCompany.findUnique({
        where: {
          discoveryRunId_companyId: {
            discoveryRunId: runJoin.discoveryRunId,
            companyId: primaryCompanyId,
          },
        },
      });

      if (!existingRunJoin) {
        await tx.discoveryRunCompany.update({
          where: { id: runJoin.id },
          data: { companyId: primaryCompanyId },
        });
      } else {
        await tx.discoveryRunCompany.delete({ where: { id: runJoin.id } });
      }
    }

    // 4. Fill in missing primary attributes from secondary
    const updatedPrimary = await tx.company.update({
      where: { id: primaryCompanyId },
      data: {
        domain: primary.domain || secondary.domain,
        industry: primary.industry || secondary.industry,
        regulatoryBody: primary.regulatoryBody || secondary.regulatoryBody,
        licenceType: primary.licenceType || secondary.licenceType,
        licenceNumber: primary.licenceNumber || secondary.licenceNumber,
        licenceStatus: primary.licenceStatus || secondary.licenceStatus,
        primarySourceUrl: primary.primarySourceUrl || secondary.primarySourceUrl,
        primarySourceAuthority: primary.primarySourceAuthority || secondary.primarySourceAuthority,
        regulatorMix: Array.from(new Set([...primary.regulatorMix, ...secondary.regulatorMix])),
        notes: [primary.notes, secondary.notes ? `[Merged from ${secondary.name}]: ${secondary.notes}` : null]
          .filter(Boolean)
          .join('\n\n'),
      },
    });

    // 5. Soft-delete secondary company
    await tx.company.update({
      where: { id: secondaryCompanyId },
      data: {
        deletedAt: new Date(),
        notes: `[MERGED INTO ${primaryCompanyId}] ${secondary.notes || ''}`.trim(),
      },
    });

    // 6. Audit log
    await tx.auditLog.create({
      data: {
        userId,
        action: 'MARKETING_COMPANY_MERGED',
        entityType: 'Company',
        entityId: primaryCompanyId,
        metadata: {
          secondaryCompanyId,
          secondaryName: secondary.name,
          contactsMoved: secondary.contacts.length,
          evidenceMoved: secondary.evidence.length,
        },
      },
    });

    logger.info({
      type: 'marketing_company_merged',
      primaryCompanyId,
      secondaryCompanyId,
      userId,
    });

    return updatedPrimary;
  });
}
