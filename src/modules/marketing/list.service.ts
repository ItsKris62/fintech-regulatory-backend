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

import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { NotFoundError } from '@/utils/error';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
