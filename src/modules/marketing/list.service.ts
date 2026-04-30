/**
 * Contact List Service
 *
 * CRUD operations for ContactList records plus membership management.
 *
 * Soft-delete: lists are never hard-deleted; deletedAt is set instead.
 * All read operations filter deletedAt: null unless explicitly fetching deleted.
 *
 * Membership:
 *   addContacts    — createMany with skipDuplicates (idempotent)
 *   removeContacts — deleteMany (idempotent, no-op if membership missing)
 *   Both operations log the count of affected memberships, not individual IDs.
 *
 * Audit actions:
 *   MARKETING_LIST_CREATED | MARKETING_LIST_UPDATED | MARKETING_LIST_DELETED |
 *   MARKETING_LIST_CONTACTS_ADDED | MARKETING_LIST_CONTACTS_REMOVED
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { BadRequestError, NotFoundError } from '@/utils/error';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Contact with company included — used by the send pipeline for personalization.
 */
export type ContactWithCompany = Prisma.ContactGetPayload<{ include: { company: true } }>;

/** Hard cap on sendable contacts per list resolution. */
const RESOLVE_CONTACTS_CAP = 5000;

export interface CreateListParams {
  name:        string;
  description?: string;
}

export interface UpdateListParams {
  name?:        string;
  description?: string;
}

export interface ListListsParams {
  query?: string;
  take?:  number;
  skip?:  number;
}

export interface GetListMembersParams {
  listId: string;
  take?:  number;
  skip?:  number;
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
// List helpers
// ---------------------------------------------------------------------------

async function requireList(id: string) {
  const list = await prisma.contactList.findUnique({
    where:  { id },
    select: { id: true, deletedAt: true },
  });
  if (!list || list.deletedAt) throw new NotFoundError('Contact list not found');
  return list;
}

// ---------------------------------------------------------------------------
// Public API — CRUD
// ---------------------------------------------------------------------------

export async function createList(
  params: CreateListParams,
  userId: string,
) {
  const list = await prisma.contactList.create({
    data: {
      name:        params.name.trim(),
      description: params.description?.trim() || null,
      createdById: userId,
    },
  });

  await writeAuditLog(userId, 'MARKETING_LIST_CREATED', 'ContactList', list.id, {
    name: list.name,
  });

  logger.info({ type: 'marketing_list_created', listId: list.id });
  return list;
}

export async function updateList(
  id: string,
  params: UpdateListParams,
  userId: string,
) {
  await requireList(id);

  const list = await prisma.contactList.update({
    where: { id },
    data: {
      ...(params.name        !== undefined ? { name:        params.name.trim()               } : {}),
      ...(params.description !== undefined ? { description: params.description.trim() || null } : {}),
    },
  });

  await writeAuditLog(userId, 'MARKETING_LIST_UPDATED', 'ContactList', id, { updated: params });
  logger.info({ type: 'marketing_list_updated', listId: id });
  return list;
}

export async function deleteList(id: string, userId: string): Promise<void> {
  await requireList(id);

  await prisma.contactList.update({
    where: { id },
    data:  { deletedAt: new Date() },
  });

  await writeAuditLog(userId, 'MARKETING_LIST_DELETED', 'ContactList', id);
  logger.info({ type: 'marketing_list_deleted', listId: id });
}

export async function getList(id: string) {
  const list = await prisma.contactList.findUnique({
    where: { id },
    include: {
      _count: { select: { memberships: true } },
    },
  });
  if (!list || list.deletedAt) throw new NotFoundError('Contact list not found');
  return list;
}

export async function listLists(params: ListListsParams = {}) {
  const { query, take = 50, skip = 0 } = params;

  return prisma.contactList.findMany({
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
      description: true,
      isDynamic:   true,
      createdAt:   true,
      _count:      { select: { memberships: true } },
    },
  });
}

// ---------------------------------------------------------------------------
// Membership management
// ---------------------------------------------------------------------------

/**
 * Add contacts to a list. Idempotent — existing memberships are silently skipped
 * (createMany with skipDuplicates). Returns the count of net-new memberships added.
 */
export async function addContacts(
  listId:     string,
  contactIds: string[],
  userId:     string,
): Promise<number> {
  await requireList(listId);

  if (contactIds.length === 0) return 0;

  const result = await prisma.contactListMembership.createMany({
    data: contactIds.map((contactId) => ({
      listId,
      contactId,
      addedById: userId,
    })),
    skipDuplicates: true,
  });

  await writeAuditLog(userId, 'MARKETING_LIST_CONTACTS_ADDED', 'ContactList', listId, {
    count:      result.count,
    contactIds: contactIds.slice(0, 50), // cap metadata payload
  });

  logger.info({ type: 'marketing_list_contacts_added', listId, count: result.count });
  return result.count;
}

/**
 * Remove contacts from a list. Idempotent — missing memberships are a no-op.
 * Returns the count of memberships deleted.
 */
export async function removeContacts(
  listId:     string,
  contactIds: string[],
  userId:     string,
): Promise<number> {
  await requireList(listId);

  if (contactIds.length === 0) return 0;

  const result = await prisma.contactListMembership.deleteMany({
    where: {
      listId,
      contactId: { in: contactIds },
    },
  });

  await writeAuditLog(userId, 'MARKETING_LIST_CONTACTS_REMOVED', 'ContactList', listId, {
    count:      result.count,
    contactIds: contactIds.slice(0, 50),
  });

  logger.info({ type: 'marketing_list_contacts_removed', listId, count: result.count });
  return result.count;
}

/**
 * Resolve all sendable contacts for a list.
 *
 * B1 spec gap retrofit (Phase B2 TG1):
 *   - Filters: consentStatus !== REVOKED, suppressedAt: null, deletedAt: null
 *   - Includes company for downstream template personalization
 *   - Hard cap: 5000 contacts. Throws BadRequestError if exceeded.
 *   - Static lists: resolved via ContactListMembership
 *   - Dynamic lists: resolved via stored filterCriteria JSONB
 *
 * Does NOT modify getListMembers — that remains for paginated UI use.
 */
export async function resolveContacts(listId: string): Promise<ContactWithCompany[]> {
  // Fetch the list to determine type and get name for error messages
  const list = await prisma.contactList.findUnique({
    where: { id: listId },
    select: { id: true, name: true, isDynamic: true, filterCriteria: true, deletedAt: true },
  });

  if (!list || list.deletedAt) {
    throw new NotFoundError('Contact list not found');
  }

  // Base contact filter — always applied regardless of list type
  const baseContactWhere: Prisma.ContactWhereInput = {
    deletedAt:     null,
    suppressedAt:  null,
    consentStatus: { not: 'REVOKED' },
    // If the contact has a company, that company must not be soft-deleted
    OR: [
      { companyId: null },
      { company: { deletedAt: null } },
    ],
  };

  if (list.isDynamic) {
    // Dynamic list: merge stored filterCriteria into the base where clause
    const storedFilter = (list.filterCriteria ?? {}) as Prisma.ContactWhereInput;

    const dynamicWhere: Prisma.ContactWhereInput = {
      AND: [baseContactWhere, storedFilter],
    };

    // Count first to enforce cap without loading all rows
    const count = await prisma.contact.count({ where: dynamicWhere });

    if (count > RESOLVE_CONTACTS_CAP) {
      throw new BadRequestError(
        `List '${list.name}' resolves to more than ${RESOLVE_CONTACTS_CAP} contacts. Segment further or use a smaller list.`,
      );
    }

    return prisma.contact.findMany({
      where:   dynamicWhere,
      include: { company: true },
    });
  } else {
    // Static list: resolve via ContactListMembership

    // Count first to enforce cap
    const count = await prisma.contactListMembership.count({
      where: {
        listId,
        contact: baseContactWhere,
      },
    });

    if (count > RESOLVE_CONTACTS_CAP) {
      throw new BadRequestError(
        `List '${list.name}' resolves to more than ${RESOLVE_CONTACTS_CAP} contacts. Segment further or use a smaller list.`,
      );
    }

    const memberships = await prisma.contactListMembership.findMany({
      where: {
        listId,
        contact: baseContactWhere,
      },
      include: {
        contact: {
          include: { company: true },
        },
      },
    });

    return memberships.map((m) => m.contact);
  }
}

/**
 * Paginated member listing for a list.
 * Filters out soft-deleted contacts so removed contacts don't appear in the result.
 */
export async function getListMembers(params: GetListMembersParams) {
  const { listId, take = 50, skip = 0 } = params;
  await requireList(listId);

  return prisma.contactListMembership.findMany({
    where: {
      listId,
      contact: { deletedAt: null },
    },
    orderBy: { addedAt: 'desc' },
    take,
    skip,
    select: {
      addedAt: true,
      contact: {
        select: {
          id:            true,
          email:         true,
          firstName:     true,
          lastName:      true,
          role:          true,
          consentStatus: true,
          suppressedAt:  true,
          company:       { select: { id: true, name: true } },
        },
      },
    },
  });
}
