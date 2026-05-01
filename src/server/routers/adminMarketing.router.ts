/**
 * Admin Marketing Router — Phase B3
 *
 * All procedures require ADMIN role (via adminProcedure).
 *
 * Sub-routers:
 *   campaigns   — 12 procedures (10 from B2 + getJobStatus + duplicate)
 *   contacts    — 8 procedures
 *   lists       — 8 procedures
 *   suppression — 4 procedures
 *
 * Schema facts (from prisma/schema.prisma):
 *   - Contact: consentStatus = ContactConsentStatus, no jobTitle (use role), consentRecords relation
 *   - ContactList: isDynamic: Boolean (no type enum), no deletedAt (use soft-delete via updatedAt)
 *   - ContactListMembership: @@id([listId, contactId]), requires addedById
 *   - SuppressionList: addedAt (not createdAt)
 *   - EmailEvent: no contactId — linked via sendId → CampaignSend
 *   - ConsentRecord: action = ConsentAction enum
 *   - suppress() / recordConsent() are standalone functions (not class methods)
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  ContactConsentStatus,
  ConsentAction,
  MarketingCampaignStatus,
  MarketingTemplateKey,
  SuppressionReason,
} from '@prisma/client';
import { router, adminProcedure } from '../trpc/trpc';
import { prisma } from '@/lib/prisma/client';
import { campaignService, RecipientLimitError } from '@/modules/marketing/campaign.service';
import { suppress, isSuppressed } from '@/modules/marketing/suppression.service';
import { recordConsent } from '@/modules/marketing/consent.service';
import { sendQueueService } from '@/modules/marketing/send-queue.service';
import { BadRequestError, NotFoundError } from '@/utils/error';
import { logger } from '@/utils/logger';

// ---------------------------------------------------------------------------
// Error mapping helper
// ---------------------------------------------------------------------------

function mapServiceError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  if (error instanceof RecipientLimitError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  }
  if (error instanceof NotFoundError) {
    throw new TRPCError({ code: 'NOT_FOUND', message: error.message });
  }
  if (error instanceof BadRequestError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  }
  throw new TRPCError({
    code:    'INTERNAL_SERVER_ERROR',
    message: error instanceof Error ? error.message : 'An unexpected error occurred.',
  });
}

// ---------------------------------------------------------------------------
// Enum value arrays (Zod v4 pattern)
// ---------------------------------------------------------------------------

const CAMPAIGN_STATUS_VALUES    = Object.values(MarketingCampaignStatus)    as [MarketingCampaignStatus,    ...MarketingCampaignStatus[]];
const TEMPLATE_KEY_VALUES       = Object.values(MarketingTemplateKey)       as [MarketingTemplateKey,       ...MarketingTemplateKey[]];
const CONSENT_STATUS_VALUES     = Object.values(ContactConsentStatus)       as [ContactConsentStatus,       ...ContactConsentStatus[]];
const CONSENT_ACTION_VALUES     = Object.values(ConsentAction)              as [ConsentAction,              ...ConsentAction[]];
const SUPPRESSION_REASON_VALUES = Object.values(SuppressionReason)         as [SuppressionReason,          ...SuppressionReason[]];

// ---------------------------------------------------------------------------
// Audit log helper
// ---------------------------------------------------------------------------

async function writeAuditLog(
  userId:     string,
  action:     string,
  entityType: string,
  entityId:   string,
  metadata?:  Record<string, unknown>,
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

// ===========================================================================
// CAMPAIGNS sub-router
// ===========================================================================

const campaignsRouter = router({
  list: adminProcedure
    .input(z.object({
      status:      z.enum(CAMPAIGN_STATUS_VALUES).optional(),
      createdById: z.string().optional(),
      search:      z.string().optional(),
      take:        z.number().int().min(1).max(100).default(20),
      skip:        z.number().int().min(0).default(0),
    }))
    .query(async ({ input }) => {
      try {
        return await campaignService.list({
          status:      input.status,
          createdById: input.createdById,
          take:        input.take,
          skip:        input.skip,
        });
      } catch (error: unknown) { mapServiceError(error); }
    }),

  getById: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        const campaign = await campaignService.getById(input.id);
        if (!campaign) throw new TRPCError({ code: 'NOT_FOUND', message: `Campaign '${input.id}' not found` });
        return campaign;
      } catch (error: unknown) { mapServiceError(error); }
    }),

  create: adminProcedure
    .input(z.object({
      name:              z.string().min(1).max(200),
      subject:           z.string().min(1).max(500),
      templateKey:       z.enum(TEMPLATE_KEY_VALUES),
      templateVariables: z.record(z.string(), z.unknown()),
      listId:            z.string().min(1),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        return await campaignService.create({
          name:              input.name,
          subject:           input.subject,
          templateKey:       input.templateKey as MarketingTemplateKey,
          templateVariables: input.templateVariables,
          listId:            input.listId,
          createdById:       ctx.user!.id,
        });
      } catch (error: unknown) { mapServiceError(error); }
    }),

  update: adminProcedure
    .input(z.object({
      id:                z.string().min(1),
      name:              z.string().min(1).max(200).optional(),
      subject:           z.string().min(1).max(500).optional(),
      templateVariables: z.record(z.string(), z.unknown()).optional(),
      listId:            z.string().min(1).optional(),
      scheduledFor:      z.string().datetime().optional().nullable(),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        const { id, scheduledFor, ...rest } = input;
        return await campaignService.update(
          id,
          {
            ...rest,
            scheduledFor: scheduledFor !== undefined
              ? (scheduledFor ? new Date(scheduledFor) : null)
              : undefined,
          },
          ctx.user!.id,
        );
      } catch (error: unknown) { mapServiceError(error); }
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      try {
        await campaignService.delete(input.id, ctx.user!.id);
        return { success: true };
      } catch (error: unknown) { mapServiceError(error); }
    }),

  requestSendConfirmation: adminProcedure
    .input(z.object({ campaignId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      try {
        return await campaignService.requestSendConfirmation({
          campaignId:    input.campaignId,
          requestedById: ctx.user!.id,
        });
      } catch (error: unknown) { mapServiceError(error); }
    }),

  executeSend: adminProcedure
    .input(z.object({
      campaignId:              z.string().min(1),
      confirmationToken:       z.string().min(1),
      confirmedRecipientCount: z.number().int().min(0),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        return await campaignService.executeSend({
          campaignId:              input.campaignId,
          confirmationToken:       input.confirmationToken,
          confirmedRecipientCount: input.confirmedRecipientCount,
          executedById:            ctx.user!.id,
        });
      } catch (error: unknown) { mapServiceError(error); }
    }),

  cancel: adminProcedure
    .input(z.object({ campaignId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      try {
        await campaignService.cancel(input.campaignId, ctx.user!.id);
        return { success: true };
      } catch (error: unknown) { mapServiceError(error); }
    }),

  getStats: adminProcedure
    .input(z.object({ campaignId: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        return await campaignService.getStats(input.campaignId);
      } catch (error: unknown) { mapServiceError(error); }
    }),

  getRecentSends: adminProcedure
    .input(z.object({
      campaignId: z.string().min(1),
      take:       z.number().int().min(1).max(200).default(50),
    }))
    .query(async ({ input }) => {
      try {
        return await campaignService.getRecentSends(input.campaignId, input.take);
      } catch (error: unknown) { mapServiceError(error); }
    }),

  /** B3: Get the latest CampaignSendJob for a campaign (for async progress UI). */
  getJobStatus: adminProcedure
    .input(z.object({ campaignId: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        const job = await sendQueueService.getLatestJob(input.campaignId);
        if (!job) return null;
        const remaining = await sendQueueService.getQueueDepth(input.campaignId);
        return { ...job, remaining };
      } catch (error: unknown) { mapServiceError(error); }
    }),

  /** Duplicate a campaign as a new DRAFT. */
  duplicate: adminProcedure
    .input(z.object({ campaignId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      try {
        const original = await campaignService.getById(input.campaignId);
        if (!original) throw new TRPCError({ code: 'NOT_FOUND', message: 'Campaign not found' });
        return await campaignService.create({
          name:              `${original.name} (Copy)`,
          subject:           original.subject,
          templateKey:       original.templateKey,
          templateVariables: original.templateVariables as Record<string, unknown>,
          listId:            original.listId ?? '',
          createdById:       ctx.user!.id,
        });
      } catch (error: unknown) { mapServiceError(error); }
    }),
});

// ===========================================================================
// CONTACTS sub-router
// Schema: Contact has firstName?, lastName?, role?, phone?, consentStatus (ContactConsentStatus),
//         suppressedAt?, suppressedReason?, consentRecords (ConsentRecord[])
// ===========================================================================

const contactsRouter = router({
  list: adminProcedure
    .input(z.object({
      search:        z.string().optional(),
      consentStatus: z.enum(CONSENT_STATUS_VALUES).optional(),
      suppressed:    z.boolean().optional(),
      companyId:     z.string().optional(),
      take:          z.number().int().min(1).max(100).default(20),
      skip:          z.number().int().min(0).default(0),
    }))
    .query(async ({ input }) => {
      try {
        const where: Record<string, unknown> = { deletedAt: null };
        if (input.consentStatus) where['consentStatus'] = input.consentStatus;
        if (input.suppressed === true)  where['suppressedAt'] = { not: null };
        if (input.suppressed === false) where['suppressedAt'] = null;
        if (input.companyId)  where['companyId'] = input.companyId;
        if (input.search) {
          where['OR'] = [
            { firstName: { contains: input.search, mode: 'insensitive' } },
            { lastName:  { contains: input.search, mode: 'insensitive' } },
            { email:     { contains: input.search, mode: 'insensitive' } },
          ];
        }

        const [items, total] = await prisma.$transaction([
          prisma.contact.findMany({
            where,
            include: { company: { select: { id: true, name: true } } },
            orderBy: { createdAt: 'desc' },
            take:    input.take,
            skip:    input.skip,
          }),
          prisma.contact.count({ where }),
        ]);

        return { items, total };
      } catch (error: unknown) { mapServiceError(error); }
    }),

  getById: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        const contact = await prisma.contact.findUnique({
          where:   { id: input.id },
          include: {
            company:        { select: { id: true, name: true } },
            consentRecords: { orderBy: { occurredAt: 'desc' }, take: 20 },
          },
        });
        if (!contact) throw new TRPCError({ code: 'NOT_FOUND', message: 'Contact not found' });
        return contact;
      } catch (error: unknown) { mapServiceError(error); }
    }),

  create: adminProcedure
    .input(z.object({
      firstName:    z.string().max(100).optional(),
      lastName:     z.string().max(100).optional(),
      email:        z.string().email(),
      phone:        z.string().max(30).optional(),
      role:         z.string().max(200).optional(),
      companyId:    z.string().optional(),
      grantConsent: z.boolean().default(false),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        const existing = await prisma.contact.findUnique({ where: { email: input.email } });
        if (existing) throw new TRPCError({ code: 'CONFLICT', message: `Contact with email ${input.email} already exists` });

        const contact = await prisma.contact.create({
          data: {
            firstName:     input.firstName,
            lastName:      input.lastName,
            email:         input.email,
            phone:         input.phone,
            role:          input.role,
            companyId:     input.companyId,
            consentStatus: input.grantConsent ? ContactConsentStatus.GRANTED : ContactConsentStatus.PENDING,
            consentSource: input.grantConsent ? 'admin_manual' : undefined,
            createdById:   ctx.user!.id,
          },
        });

        if (input.grantConsent) {
          await recordConsent({
            contactId: contact.id,
            action:    ConsentAction.GRANTED,
            source:    'admin_manual',
          });
        }

        await writeAuditLog(ctx.user!.id, 'MARKETING_CONTACT_CREATED', 'Contact', contact.id, { email: contact.email });
        return contact;
      } catch (error: unknown) { mapServiceError(error); }
    }),

  update: adminProcedure
    .input(z.object({
      id:        z.string().min(1),
      firstName: z.string().max(100).optional().nullable(),
      lastName:  z.string().max(100).optional().nullable(),
      phone:     z.string().max(30).optional().nullable(),
      role:      z.string().max(200).optional().nullable(),
      companyId: z.string().optional().nullable(),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        const { id, ...data } = input;
        const contact = await prisma.contact.update({
          where: { id },
          data: {
            ...(data.firstName !== undefined ? { firstName: data.firstName } : {}),
            ...(data.lastName  !== undefined ? { lastName:  data.lastName  } : {}),
            ...(data.phone     !== undefined ? { phone:     data.phone     } : {}),
            ...(data.role      !== undefined ? { role:      data.role      } : {}),
            ...(data.companyId !== undefined ? { companyId: data.companyId } : {}),
          },
        });
        await writeAuditLog(ctx.user!.id, 'MARKETING_CONTACT_UPDATED', 'Contact', id, { updatedFields: Object.keys(data) });
        return contact;
      } catch (error: unknown) { mapServiceError(error); }
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      try {
        await prisma.contact.update({
          where: { id: input.id },
          data:  { deletedAt: new Date() },
        });
        await writeAuditLog(ctx.user!.id, 'MARKETING_CONTACT_DELETED', 'Contact', input.id);
        return { success: true };
      } catch (error: unknown) { mapServiceError(error); }
    }),

  bulkImport: adminProcedure
    .input(z.object({
      contacts: z.array(z.object({
        email:       z.string().email(),
        firstName:   z.string().max(100).optional(),
        lastName:    z.string().max(100).optional(),
        phone:       z.string().max(30).optional(),
        role:        z.string().max(200).optional(),
        companyName: z.string().max(200).optional(),
      })).min(1).max(500),
      grantConsent: z.boolean().default(true),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        let created = 0;
        let updated = 0;
        let skipped = 0;
        const errors: Array<{ email: string; error: string }> = [];

        for (const row of input.contacts) {
          try {
            const existing = await prisma.contact.findUnique({ where: { email: row.email } });

            if (existing) {
              await prisma.contact.update({
                where: { id: existing.id },
                data: {
                  firstName: row.firstName ?? existing.firstName,
                  lastName:  row.lastName  ?? existing.lastName,
                  phone:     row.phone     ?? existing.phone,
                  role:      row.role      ?? existing.role,
                  ...(input.grantConsent && existing.consentStatus !== ContactConsentStatus.GRANTED
                    ? { consentStatus: ContactConsentStatus.GRANTED, consentSource: 'bulk_import' }
                    : {}),
                },
              });
              if (input.grantConsent && existing.consentStatus !== ContactConsentStatus.GRANTED) {
                await recordConsent({
                  contactId: existing.id,
                  action:    ConsentAction.GRANTED,
                  source:    'bulk_import',
                });
              }
              updated++;
            } else {
              const contact = await prisma.contact.create({
                data: {
                  email:         row.email,
                  firstName:     row.firstName,
                  lastName:      row.lastName,
                  phone:         row.phone,
                  role:          row.role,
                  consentStatus: input.grantConsent ? ContactConsentStatus.GRANTED : ContactConsentStatus.PENDING,
                  consentSource: input.grantConsent ? 'bulk_import' : undefined,
                  createdById:   ctx.user!.id,
                },
              });
              if (input.grantConsent) {
                await recordConsent({
                  contactId: contact.id,
                  action:    ConsentAction.GRANTED,
                  source:    'bulk_import',
                });
              }
              created++;
            }
          } catch (err: unknown) {
            errors.push({ email: row.email, error: err instanceof Error ? err.message : String(err) });
            skipped++;
          }
        }

        await writeAuditLog(ctx.user!.id, 'MARKETING_CONTACTS_BULK_IMPORTED', 'Contact', 'bulk', {
          created, updated, skipped, total: input.contacts.length,
        });

        return { created, updated, skipped, errors };
      } catch (error: unknown) { mapServiceError(error); }
    }),

  recordConsent: adminProcedure
    .input(z.object({
      contactId: z.string().min(1),
      action:    z.enum(CONSENT_ACTION_VALUES),
      source:    z.string().min(1).max(100),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        await recordConsent({
          contactId: input.contactId,
          action:    input.action,
          source:    input.source,
        });
        await writeAuditLog(ctx.user!.id, 'MARKETING_CONSENT_RECORDED', 'Contact', input.contactId, {
          action: input.action, source: input.source,
        });
        return { success: true };
      } catch (error: unknown) { mapServiceError(error); }
    }),

  getEmailHistory: adminProcedure
    .input(z.object({
      contactId: z.string().min(1),
      take:      z.number().int().min(1).max(100).default(20),
      skip:      z.number().int().min(0).default(0),
    }))
    .query(async ({ input }) => {
      try {
        // EmailEvent is linked via CampaignSend → contactId
        const [items, total] = await prisma.$transaction([
          prisma.emailEvent.findMany({
            where:   { send: { contactId: input.contactId } },
            orderBy: { occurredAt: 'desc' },
            take:    input.take,
            skip:    input.skip,
            include: { send: { select: { campaignId: true, status: true, sentAt: true } } },
          }),
          prisma.emailEvent.count({ where: { send: { contactId: input.contactId } } }),
        ]);
        return { items, total };
      } catch (error: unknown) { mapServiceError(error); }
    }),
});

// ===========================================================================
// LISTS sub-router
// Schema: ContactList has isDynamic: Boolean (no type enum), no deletedAt
//         ContactListMembership: @@id([listId, contactId]), requires addedById
// ===========================================================================

const listsRouter = router({
  list: adminProcedure
    .input(z.object({
      take: z.number().int().min(1).max(100).default(20),
      skip: z.number().int().min(0).default(0),
    }))
    .query(async ({ input }) => {
      try {
        const where = { deletedAt: null };
        const [items, total] = await prisma.$transaction([
          prisma.contactList.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take:    input.take,
            skip:    input.skip,
            include: { _count: { select: { memberships: true } } },
          }),
          prisma.contactList.count({ where }),
        ]);
        return { items, total };
      } catch (error: unknown) { mapServiceError(error); }
    }),

  getById: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        const list = await prisma.contactList.findUnique({
          where:   { id: input.id },
          include: {
            _count:      { select: { memberships: true } },
            memberships: {
              take:    10,
              include: { contact: { select: { id: true, firstName: true, lastName: true, email: true } } },
            },
          },
        });
        if (!list) throw new TRPCError({ code: 'NOT_FOUND', message: 'List not found' });
        return list;
      } catch (error: unknown) { mapServiceError(error); }
    }),

  create: adminProcedure
    .input(z.object({
      name:           z.string().min(1).max(200),
      description:    z.string().max(1000).optional(),
      isDynamic:      z.boolean().default(false),
      filterCriteria: z.record(z.string(), z.unknown()).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        const list = await prisma.contactList.create({
          data: {
            name:           input.name,
            description:    input.description,
            isDynamic:      input.isDynamic,
            filterCriteria: input.filterCriteria ?? undefined,
            createdById:    ctx.user!.id,
          },
        });
        await writeAuditLog(ctx.user!.id, 'MARKETING_LIST_CREATED', 'ContactList', list.id, {
          name: list.name, isDynamic: list.isDynamic,
        });
        return list;
      } catch (error: unknown) { mapServiceError(error); }
    }),

  update: adminProcedure
    .input(z.object({
      id:             z.string().min(1),
      name:           z.string().min(1).max(200).optional(),
      description:    z.string().max(1000).optional().nullable(),
      filterCriteria: z.record(z.string(), z.unknown()).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        const { id, ...data } = input;
        const list = await prisma.contactList.update({
          where: { id },
          data: {
            ...(data.name           !== undefined ? { name:           data.name           } : {}),
            ...(data.description    !== undefined ? { description:    data.description    } : {}),
            ...(data.filterCriteria !== undefined ? { filterCriteria: data.filterCriteria } : {}),
          },
        });
        await writeAuditLog(ctx.user!.id, 'MARKETING_LIST_UPDATED', 'ContactList', id, { updatedFields: Object.keys(data) });
        return list;
      } catch (error: unknown) { mapServiceError(error); }
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      try {
        await prisma.contactList.update({
          where: { id: input.id },
          data:  { deletedAt: new Date() },
        });
        await writeAuditLog(ctx.user!.id, 'MARKETING_LIST_DELETED', 'ContactList', input.id);
        return { success: true };
      } catch (error: unknown) { mapServiceError(error); }
    }),

  addMembers: adminProcedure
    .input(z.object({
      listId:     z.string().min(1),
      contactIds: z.array(z.string().min(1)).min(1).max(500),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        const list = await prisma.contactList.findUnique({ where: { id: input.listId } });
        if (!list) throw new TRPCError({ code: 'NOT_FOUND', message: 'List not found' });
        if (list.isDynamic) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot manually add members to a dynamic list' });
        }

        let added = 0;
        let skipped = 0;
        for (const contactId of input.contactIds) {
          // @@id([listId, contactId]) — use findUnique with compound id
          const existing = await prisma.contactListMembership.findUnique({
            where: { listId_contactId: { listId: input.listId, contactId } },
          });
          if (existing) { skipped++; continue; }
          await prisma.contactListMembership.create({
            data: { contactId, listId: input.listId, addedById: ctx.user!.id },
          });
          added++;
        }

        await writeAuditLog(ctx.user!.id, 'MARKETING_LIST_MEMBERS_ADDED', 'ContactList', input.listId, { added, skipped });
        return { added, skipped };
      } catch (error: unknown) { mapServiceError(error); }
    }),

  removeMembers: adminProcedure
    .input(z.object({
      listId:     z.string().min(1),
      contactIds: z.array(z.string().min(1)).min(1).max(500),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        const result = await prisma.contactListMembership.deleteMany({
          where: {
            listId:    input.listId,
            contactId: { in: input.contactIds },
          },
        });
        await writeAuditLog(ctx.user!.id, 'MARKETING_LIST_MEMBERS_REMOVED', 'ContactList', input.listId, { removed: result.count });
        return { removed: result.count };
      } catch (error: unknown) { mapServiceError(error); }
    }),

  previewDynamic: adminProcedure
    .input(z.object({ filterCriteria: z.record(z.string(), z.unknown()) }))
    .query(async ({ input }) => {
      try {
        const criteria = input.filterCriteria as Record<string, unknown>;
        const where: Record<string, unknown> = { deletedAt: null };

        if (criteria['consentStatus']) where['consentStatus'] = criteria['consentStatus'];
        if (criteria['suppressedAt'] === 'null')     where['suppressedAt'] = null;
        if (criteria['suppressedAt'] === 'not_null') where['suppressedAt'] = { not: null };
        if (criteria['companyId'])  where['companyId'] = criteria['companyId'];
        if (criteria['role'])       where['role'] = { contains: criteria['role'] as string, mode: 'insensitive' };

        const [count, sample] = await prisma.$transaction([
          prisma.contact.count({ where }),
          prisma.contact.findMany({
            where,
            take:   10,
            select: { id: true, firstName: true, lastName: true, email: true },
          }),
        ]);

        return { count, sample };
      } catch (error: unknown) { mapServiceError(error); }
    }),

  getMembers: adminProcedure
    .input(z.object({
      listId: z.string().min(1),
      take:   z.number().int().min(1).max(100).default(20),
      skip:   z.number().int().min(0).default(0),
    }))
    .query(async ({ input }) => {
      try {
        const [items, total] = await prisma.$transaction([
          prisma.contactListMembership.findMany({
            where:   { listId: input.listId },
            include: {
              contact: {
                select: {
                  id: true, firstName: true, lastName: true,
                  email: true, consentStatus: true, suppressedAt: true,
                },
              },
            },
            orderBy: { addedAt: 'desc' },
            take:    input.take,
            skip:    input.skip,
          }),
          prisma.contactListMembership.count({ where: { listId: input.listId } }),
        ]);
        return { items, total };
      } catch (error: unknown) { mapServiceError(error); }
    }),
});

// ===========================================================================
// SUPPRESSION sub-router
// Schema: SuppressionList has addedAt (not createdAt), no id-based unique for email
// ===========================================================================

const suppressionRouter = router({
  list: adminProcedure
    .input(z.object({
      reason: z.enum(SUPPRESSION_REASON_VALUES).optional(),
      take:   z.number().int().min(1).max(100).default(20),
      skip:   z.number().int().min(0).default(0),
    }))
    .query(async ({ input }) => {
      try {
        const where = input.reason ? { reason: input.reason } : {};
        const [items, total] = await prisma.$transaction([
          prisma.suppressionList.findMany({
            where,
            orderBy: { addedAt: 'desc' },
            take:    input.take,
            skip:    input.skip,
          }),
          prisma.suppressionList.count({ where }),
        ]);
        return { items, total };
      } catch (error: unknown) { mapServiceError(error); }
    }),

  add: adminProcedure
    .input(z.object({
      email:  z.string().email(),
      reason: z.enum(SUPPRESSION_REASON_VALUES),
      note:   z.string().max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        await suppress(
          input.email,
          input.reason,
          ctx.user!.id,
          { source: 'admin_manual', note: input.note },
        );
        await writeAuditLog(ctx.user!.id, 'MARKETING_SUPPRESSION_ADDED', 'SuppressionList', input.email, {
          reason: input.reason, note: input.note,
        });
        return { success: true };
      } catch (error: unknown) { mapServiceError(error); }
    }),

  remove: adminProcedure
    .input(z.object({ email: z.string().email() }))
    .mutation(async ({ input, ctx }) => {
      try {
        await prisma.suppressionList.deleteMany({ where: { email: input.email } });
        await prisma.contact.updateMany({
          where: { email: input.email },
          data:  { suppressedAt: null, suppressedReason: null },
        });
        await writeAuditLog(ctx.user!.id, 'MARKETING_SUPPRESSION_REMOVED', 'SuppressionList', input.email);
        return { success: true };
      } catch (error: unknown) { mapServiceError(error); }
    }),

  check: adminProcedure
    .input(z.object({ email: z.string().email() }))
    .query(async ({ input }) => {
      try {
        const suppressed = await isSuppressed(input.email);
        const entry = suppressed
          ? await prisma.suppressionList.findUnique({ where: { email: input.email } })
          : null;
        return {
          isSuppressed: suppressed,
          reason:       entry?.reason  ?? null,
          addedAt:      entry?.addedAt ?? null,
        };
      } catch (error: unknown) { mapServiceError(error); }
    }),
});

// ===========================================================================
// Root adminMarketing router
// ===========================================================================

export const adminMarketingRouter = router({
  campaigns:   campaignsRouter,
  contacts:    contactsRouter,
  lists:       listsRouter,
  suppression: suppressionRouter,
});
