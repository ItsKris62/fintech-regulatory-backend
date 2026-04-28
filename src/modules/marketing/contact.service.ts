/**
 * Contact Service
 *
 * CRUD + CSV bulk import for marketing Contact records.
 *
 * CSV import contract:
 *   - Expected headers (case-insensitive): email, firstName, lastName, role,
 *     phone, primaryRegulator, companyName, tags, notes
 *   - RFC 4180 state-machine parser handles quoted commas, embedded newlines,
 *     escaped double-quotes, empty cells, trailing newlines
 *   - Suppression check fires BEFORE company resolution (import guard)
 *   - Per-row $transaction (interactive): contact upsert + ConsentRecord insert
 *   - Sequential for…of — no Promise.all over rows
 *   - New contacts: consentStatus=PENDING via ConsentRecord(IMPORTED_LEGITIMATE_INTEREST)
 *   - Existing contacts: non-null CSV fields merged, consentStatus preserved
 *   - Tags: lowercase + trim, deduped, capped at 10 per contact
 *   - Single audit log entry after all rows: MARKETING_CONTACT_IMPORTED
 *
 * resolveContacts filters:
 *   - deletedAt: null
 *   - consentStatus: NOT REVOKED
 *   - suppressedAt: null
 *   - Hard cap: 5000 (BadRequestError if exceeded)
 *
 * Audit actions:
 *   MARKETING_CONTACT_CREATED | MARKETING_CONTACT_UPDATED |
 *   MARKETING_CONTACT_DELETED | MARKETING_CONTACT_IMPORTED
 */

import { ConsentAction } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { NotFoundError, BadRequestError } from '@/utils/error';
import { isSuppressed } from './suppression.service';
import { findOrCreateByEmailDomain } from './company.service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TAGS           = 10;
const RESOLVE_HARD_CAP   = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateContactParams {
  email: string;
  firstName?:       string;
  lastName?:        string;
  role?:            string;
  phone?:           string;
  primaryRegulator?: string;
  companyId?:       string;
  tags?:            string[];
  notes?:           string;
}

export interface UpdateContactParams {
  firstName?:       string;
  lastName?:        string;
  role?:            string;
  phone?:           string;
  primaryRegulator?: string;
  companyId?:       string;
  tags?:            string[];
  notes?:           string;
}

export interface ListContactsParams {
  query?: string;
  companyId?: string;
  take?: number;
  skip?: number;
}

export interface ImportContactsCsvParams {
  csvText: string;
  source?: string;
}

export interface ImportResult {
  created:  number;
  updated:  number;
  skipped:  number;
  errors:   Array<{ row: number; email: string; reason: string }>;
}

export interface ResolvedContact {
  id:         string;
  email:      string;
  firstName:  string | null;
  lastName:   string | null;
}

export interface ResolveContactsParams {
  contactIds?: string[];
  listIds?:    string[];
}

// ---------------------------------------------------------------------------
// RFC 4180 CSV parser (state-machine)
// ---------------------------------------------------------------------------

/**
 * Parse CSV text into a 2D array of strings (rows × cells).
 * Handles:
 *   - Quoted fields containing commas, newlines, and escaped double-quotes ("")
 *   - Empty cells and trailing newlines
 *   - CRLF and LF line endings
 *
 * Does NOT produce a trailing empty row for a trailing newline.
 */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[]  = [];
  let cell           = '';
  let inQuote        = false;
  let i              = 0;
  const len          = text.length;

  while (i < len) {
    const ch = text[i];

    if (inQuote) {
      if (ch === '"') {
        // Peek ahead: "" → escaped quote inside field
        if (i + 1 < len && text[i + 1] === '"') {
          cell += '"';
          i += 2;
        } else {
          // Closing quote — exit quoted mode
          inQuote = false;
          i++;
        }
      } else {
        cell += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuote = true;
        i++;
      } else if (ch === ',') {
        row.push(cell);
        cell = '';
        i++;
      } else if (ch === '\r') {
        // CRLF — consume the \n if present
        row.push(cell);
        cell = '';
        rows.push(row);
        row = [];
        i++;
        if (i < len && text[i] === '\n') i++;
      } else if (ch === '\n') {
        row.push(cell);
        cell = '';
        rows.push(row);
        row = [];
        i++;
      } else {
        cell += ch;
        i++;
      }
    }
  }

  // Flush last cell + row (handles files without trailing newline)
  // Discard if the final "row" is a single empty cell (trailing newline artefact)
  if (row.length > 0 || cell !== '') {
    row.push(cell);
    if (!(row.length === 1 && row[0] === '')) {
      rows.push(row);
    }
  }

  return rows;
}

/**
 * Map a parsed CSV row to a dict keyed by lowercase column name.
 * Trims every value.
 */
function rowToRecord(headers: string[], values: string[]): Record<string, string> {
  const rec: Record<string, string> = {};
  for (let i = 0; i < headers.length; i++) {
    rec[headers[i]] = (values[i] ?? '').trim();
  }
  return rec;
}

// ---------------------------------------------------------------------------
// Tag normalization
// ---------------------------------------------------------------------------

function normalizeTags(raw: string): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((t) => t.toLowerCase().trim())
        .filter(Boolean),
    ),
  ].slice(0, MAX_TAGS);
}

function mergeTagArrays(existing: string[], incoming: string[]): string[] {
  return [...new Set([...existing, ...incoming])].slice(0, MAX_TAGS);
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
// Public API — CRUD
// ---------------------------------------------------------------------------

export async function createContact(
  params: CreateContactParams,
  userId: string,
) {
  const email = params.email.trim().toLowerCase();

  const contact = await prisma.contact.create({
    data: {
      email,
      firstName:        params.firstName?.trim()        || null,
      lastName:         params.lastName?.trim()         || null,
      role:             params.role?.trim()             || null,
      phone:            params.phone?.trim()            || null,
      primaryRegulator: params.primaryRegulator?.trim() || null,
      companyId:        params.companyId               || null,
      tags:             params.tags?.map((t) => t.toLowerCase().trim()).filter(Boolean).slice(0, MAX_TAGS) ?? [],
      notes:            params.notes?.trim()            || null,
      createdById:      userId,
    },
  });

  await writeAuditLog(userId, 'MARKETING_CONTACT_CREATED', 'Contact', contact.id, {
    email,
  });

  logger.info({ type: 'marketing_contact_created', contactId: contact.id });
  return contact;
}

export async function updateContact(
  id: string,
  params: UpdateContactParams,
  userId: string,
) {
  const existing = await prisma.contact.findUnique({
    where: { id },
    select: { id: true, deletedAt: true },
  });
  if (!existing || existing.deletedAt) throw new NotFoundError('Contact not found');

  const contact = await prisma.contact.update({
    where: { id },
    data: {
      ...(params.firstName        !== undefined ? { firstName:        params.firstName.trim()        || null } : {}),
      ...(params.lastName         !== undefined ? { lastName:         params.lastName.trim()         || null } : {}),
      ...(params.role             !== undefined ? { role:             params.role.trim()             || null } : {}),
      ...(params.phone            !== undefined ? { phone:            params.phone.trim()            || null } : {}),
      ...(params.primaryRegulator !== undefined ? { primaryRegulator: params.primaryRegulator.trim() || null } : {}),
      ...(params.companyId        !== undefined ? { companyId:        params.companyId               || null } : {}),
      ...(params.tags             !== undefined ? {
        tags: [...new Set(params.tags.map((t) => t.toLowerCase().trim()).filter(Boolean))].slice(0, MAX_TAGS),
      } : {}),
      ...(params.notes            !== undefined ? { notes: params.notes.trim() || null } : {}),
    },
  });

  await writeAuditLog(userId, 'MARKETING_CONTACT_UPDATED', 'Contact', id, { updated: params });
  logger.info({ type: 'marketing_contact_updated', contactId: id });
  return contact;
}

export async function deleteContact(id: string, userId: string): Promise<void> {
  const existing = await prisma.contact.findUnique({
    where: { id },
    select: { id: true, deletedAt: true },
  });
  if (!existing || existing.deletedAt) throw new NotFoundError('Contact not found');

  await prisma.contact.update({
    where: { id },
    data:  { deletedAt: new Date() },
  });

  await writeAuditLog(userId, 'MARKETING_CONTACT_DELETED', 'Contact', id);
  logger.info({ type: 'marketing_contact_deleted', contactId: id });
}

export async function getContact(id: string) {
  const contact = await prisma.contact.findUnique({ where: { id } });
  if (!contact || contact.deletedAt) throw new NotFoundError('Contact not found');
  return contact;
}

export async function listContacts(params: ListContactsParams = {}) {
  const { query, companyId, take = 50, skip = 0 } = params;

  return prisma.contact.findMany({
    where: {
      deletedAt: null,
      ...(companyId ? { companyId } : {}),
      ...(query
        ? {
            OR: [
              { email:     { contains: query.trim(), mode: 'insensitive' } },
              { firstName: { contains: query.trim(), mode: 'insensitive' } },
              { lastName:  { contains: query.trim(), mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    take,
    skip,
    select: {
      id:           true,
      email:        true,
      firstName:    true,
      lastName:     true,
      role:         true,
      phone:        true,
      companyId:    true,
      company:      { select: { id: true, name: true } },
      consentStatus: true,
      suppressedAt: true,
      tags:         true,
      createdAt:    true,
    },
  });
}

// ---------------------------------------------------------------------------
// CSV Import
// ---------------------------------------------------------------------------

/**
 * Import contacts from RFC 4180 CSV text.
 *
 * Required column: email
 * Optional columns: firstName, lastName, role, phone, primaryRegulator,
 *                   companyName, tags (comma-separated within the cell), notes
 *
 * Per-row processing order:
 *   1. Normalize + validate email
 *   2. Suppression check (isSuppressed) — skip if suppressed
 *   3. Company resolution (findOrCreateByEmailDomain)
 *   4. Row-level $transaction:
 *        - New contact: create + ConsentRecord(IMPORTED_LEGITIMATE_INTEREST)
 *        - Existing contact: update non-null fields, merge tags, preserve consentStatus
 *
 * Single MARKETING_CONTACT_IMPORTED audit entry after all rows complete.
 */
export async function importContactsCsv(
  params: ImportContactsCsvParams,
  userId: string,
): Promise<ImportResult> {
  const { csvText, source = 'csv_import' } = params;

  const allRows = parseCsvRows(csvText);
  if (allRows.length < 2) {
    throw new BadRequestError('CSV must contain a header row and at least one data row');
  }

  // Normalize header names: lowercase, trim
  const rawHeaders = allRows[0];
  if (!rawHeaders) throw new BadRequestError('CSV has no header row');
  const headers = rawHeaders.map((h) => h.toLowerCase().trim());

  const emailIdx = headers.indexOf('email');
  if (emailIdx === -1) throw new BadRequestError('CSV is missing required "email" column');

  const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] };

  // Sequential row processing — no parallel upserts to avoid race conditions
  for (let rowIndex = 1; rowIndex < allRows.length; rowIndex++) {
    const rawRow = allRows[rowIndex];
    if (!rawRow) continue;

    const record  = rowToRecord(headers, rawRow);
    const rawEmail = record['email'] ?? '';
    const email    = rawEmail.trim().toLowerCase();

    if (!email) {
      result.skipped++;
      continue;
    }

    // Basic email format guard
    if (!email.includes('@') || !email.includes('.')) {
      result.errors.push({ row: rowIndex + 1, email: rawEmail, reason: 'invalid email format' });
      continue;
    }

    try {
      // 1. Suppression check BEFORE any company or DB write
      const suppressed = await isSuppressed(email);
      if (suppressed) {
        result.skipped++;
        logger.debug({ type: 'csv_import_skipped_suppressed', row: rowIndex + 1 });
        continue;
      }

      // 2. Company resolution (may create a new Company record)
      const companyName  = record['companyname'] ?? record['company_name'] ?? record['company'] ?? '';
      const companyId    = await findOrCreateByEmailDomain(email, companyName, userId);

      // 3. Normalize optional fields from CSV
      const firstName        = record['firstname']        || record['first_name']         || null;
      const lastName         = record['lastname']         || record['last_name']          || null;
      const role             = record['role']                                             || null;
      const phone            = record['phone']                                            || null;
      const primaryRegulator = record['primaryregulator'] || record['primary_regulator']  || null;
      const notesVal         = record['notes']                                            || null;
      const rawTags          = record['tags']                                             || '';
      const incomingTags     = normalizeTags(rawTags);

      // 4. Row-level atomic transaction
      const existing = await prisma.contact.findUnique({
        where:  { email },
        select: { id: true, deletedAt: true, tags: true },
      });

      if (!existing || existing.deletedAt) {
        // --- CREATE path ---
        await prisma.$transaction(async (tx) => {
          const contact = await tx.contact.create({
            data: {
              email,
              firstName:        firstName?.trim()        || null,
              lastName:         lastName?.trim()         || null,
              role:             role?.trim()             || null,
              phone:            phone?.trim()            || null,
              primaryRegulator: primaryRegulator?.trim() || null,
              companyId:        companyId               ?? null,
              tags:             incomingTags,
              notes:            notesVal?.trim()         || null,
              consentStatus:    'PENDING',
              consentSource:    source,
              consentTimestamp: new Date(),
              createdById:      userId,
            },
          });

          await tx.consentRecord.create({
            data: {
              contactId:  contact.id,
              action:     ConsentAction.IMPORTED_LEGITIMATE_INTEREST,
              source,
              occurredAt: new Date(),
            },
          });
        });

        result.created++;
      } else {
        // --- UPDATE path: merge non-null fields, preserve consentStatus ---
        const mergedTags = mergeTagArrays(existing.tags, incomingTags);

        await prisma.contact.update({
          where: { id: existing.id },
          data: {
            ...(firstName        ? { firstName:        firstName.trim()        } : {}),
            ...(lastName         ? { lastName:         lastName.trim()         } : {}),
            ...(role             ? { role:             role.trim()             } : {}),
            ...(phone            ? { phone:            phone.trim()            } : {}),
            ...(primaryRegulator ? { primaryRegulator: primaryRegulator.trim() } : {}),
            ...(companyId        ? { companyId                                 } : {}),
            ...(notesVal         ? { notes:            notesVal.trim()         } : {}),
            ...(mergedTags.length ? { tags: mergedTags }                       : {}),
          },
        });

        result.updated++;
      }
    } catch (err: unknown) {
      result.errors.push({
        row:    rowIndex + 1,
        email,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Single audit log entry for the entire import
  await writeAuditLog(userId, 'MARKETING_CONTACT_IMPORTED', 'Contact', userId, {
    source,
    created:  result.created,
    updated:  result.updated,
    skipped:  result.skipped,
    errors:   result.errors.length,
  });

  logger.info({
    type:    'marketing_contacts_imported',
    source,
    created:  result.created,
    updated:  result.updated,
    skipped:  result.skipped,
    errors:   result.errors.length,
  });

  return result;
}

// ---------------------------------------------------------------------------
// resolveContacts — used by campaign send pipeline
// ---------------------------------------------------------------------------

/**
 * Resolve a de-duped list of sendable contacts from contact IDs and/or list IDs.
 *
 * Filters applied:
 *   - deletedAt: null
 *   - consentStatus: NOT REVOKED  (PENDING and GRANTED are eligible)
 *   - suppressedAt: null          (hard-bounce / complaint / manual suppression)
 *
 * Throws BadRequestError if the resolved set would exceed RESOLVE_HARD_CAP (5000).
 *
 * Returns ResolvedContact[] (id, email, firstName, lastName).
 */
export async function resolveContacts(
  params: ResolveContactsParams,
): Promise<ResolvedContact[]> {
  const { contactIds = [], listIds = [] } = params;

  if (contactIds.length === 0 && listIds.length === 0) {
    throw new BadRequestError('At least one contactId or listId is required');
  }

  // Collect all contact IDs from lists
  let listContactIds: string[] = [];
  if (listIds.length > 0) {
    const memberships = await prisma.contactListMembership.findMany({
      where:  { listId: { in: listIds } },
      select: { contactId: true },
    });
    listContactIds = memberships.map((m) => m.contactId);
  }

  // De-dupe the union of explicit IDs + list-derived IDs
  const allIds = [...new Set([...contactIds, ...listContactIds])];

  if (allIds.length > RESOLVE_HARD_CAP) {
    throw new BadRequestError(
      `Resolved contact set (${allIds.length}) exceeds the maximum allowed (${RESOLVE_HARD_CAP})`,
    );
  }

  // Single query with all eligibility filters
  const contacts = await prisma.contact.findMany({
    where: {
      id:            { in: allIds },
      deletedAt:     null,
      suppressedAt:  null,
      consentStatus: { not: 'REVOKED' },
    },
    select: {
      id:        true,
      email:     true,
      firstName: true,
      lastName:  true,
    },
  });

  if (contacts.length > RESOLVE_HARD_CAP) {
    throw new BadRequestError(
      `Resolved contact set (${contacts.length}) exceeds the maximum allowed (${RESOLVE_HARD_CAP})`,
    );
  }

  return contacts;
}
