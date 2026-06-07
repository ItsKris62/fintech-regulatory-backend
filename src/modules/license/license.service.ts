import { TRPCError } from '@trpc/server';
import { LicenseStatus, MemberRole, MemberStatus, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';

const LICENSE_SELECT = {
  id: true,
  organizationId: true,
  licenseType: true,
  regulator: true,
  licenseNumber: true,
  status: true,
  issueDate: true,
  expiryDate: true,
  renewalDueDate: true,
  submittedAt: true,
  approvedAt: true,
  assignedOwnerId: true,
  notes: true,
  createdByUserId: true,
  updatedByUserId: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
  assignedOwner: { select: { id: true, fullName: true, email: true } },
  createdBy: { select: { id: true, fullName: true, email: true } },
  updatedBy: { select: { id: true, fullName: true, email: true } },
  _count: { select: { timelineEvents: true, documents: true, fees: true } },
} as const;

const LICENSE_DETAIL_INCLUDE = {
  assignedOwner: { select: { id: true, fullName: true, email: true } },
  createdBy: { select: { id: true, fullName: true, email: true } },
  updatedBy: { select: { id: true, fullName: true, email: true } },
  timelineEvents: {
    orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
    include: {
      assignedTo: { select: { id: true, fullName: true, email: true } },
      evidenceDocument: { select: { id: true, name: true, fileName: true, category: true } },
      complianceEvent: { select: { id: true, title: true, dueDate: true, status: true, category: true } },
    },
  },
  documents: {
    orderBy: { createdAt: 'desc' },
    include: {
      vaultDocument: { select: { id: true, name: true, fileName: true, category: true, status: true } },
      createdBy: { select: { id: true, fullName: true, email: true } },
    },
  },
  fees: {
    orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
    include: {
      createdBy: { select: { id: true, fullName: true, email: true } },
      updatedBy: { select: { id: true, fullName: true, email: true } },
    },
  },
} satisfies Prisma.LicenseInclude;

const MANAGER_ROLES = new Set<string>([MemberRole.ADMIN, MemberRole.OWNER]);
const TERMINAL_MANUAL_STATUSES = new Set<string>(['SUSPENDED', 'REVOKED', 'ARCHIVED']);

function parseDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return new Date(value);
}

function normalizeCalendarDate(value: Date): Date {
  const normalized = new Date(value);
  normalized.setUTCHours(0, 0, 0, 0);
  return normalized;
}

function daysUntil(value: Date | null | undefined): number | null {
  if (!value) return null;
  const today = normalizeCalendarDate(new Date());
  const target = normalizeCalendarDate(value);
  return Math.ceil((target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
}

function withDerivedFields<T extends { expiryDate?: Date | null; renewalDueDate?: Date | null; status?: LicenseStatus | string }>(record: T) {
  const daysUntilExpiry = daysUntil(record.expiryDate);
  const daysUntilRenewal = daysUntil(record.renewalDueDate);

  return {
    ...record,
    derived: {
      daysUntilExpiry,
      daysUntilRenewal,
      isExpired: daysUntilExpiry !== null && daysUntilExpiry < 0,
      isRenewalDueSoon: daysUntilRenewal !== null && daysUntilRenewal >= 0 && daysUntilRenewal <= 30,
      isRenewalOverdue: daysUntilRenewal !== null && daysUntilRenewal < 0 && !TERMINAL_MANUAL_STATUSES.has(String(record.status)),
    },
  };
}

function isManager(role: string): boolean {
  return MANAGER_ROLES.has(role);
}

async function audit(params: {
  userId: string;
  action: string;
  entityType: string;
  entityId?: string;
  organizationId?: string;
  metadata?: Record<string, unknown>;
}) {
  await prisma.auditLog.create({
    data: {
      userId: params.userId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      metadata: {
        organizationId: params.organizationId,
        ...(params.metadata ?? {}),
      },
    },
  });
}

export class LicenseService {
  private async assertAssignableMember(organizationId: string, userId: string | null | undefined): Promise<void> {
    if (!userId) return;
    const member = await prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { status: true },
    });

    if (!member || member.status !== MemberStatus.ACTIVE) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Assigned user must be an active member of this organization.',
      });
    }
  }

  private async assertVaultDocument(organizationId: string, vaultDocumentId: string | null | undefined): Promise<void> {
    if (!vaultDocumentId) return;
    const doc = await prisma.vaultDocument.findFirst({
      where: { id: vaultDocumentId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!doc) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Evidence document must belong to this organization.',
      });
    }
  }

  private async requireLicense(organizationId: string, licenseId: string) {
    const license = await prisma.license.findFirst({
      where: { id: licenseId, organizationId, deletedAt: null },
      select: { id: true, organizationId: true, assignedOwnerId: true, licenseType: true, regulator: true, licenseNumber: true },
    });
    if (!license) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'License not found.' });
    }
    return license;
  }

  private ensureManager(role: string): void {
    if (!isManager(role)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Only organization owners and admins can manage licenses.',
      });
    }
  }

  private async syncLicenseCalendarEvents(license: {
    id: string;
    organizationId: string;
    licenseType: string;
    regulator: string;
    licenseNumber: string | null;
    expiryDate: Date | null;
    renewalDueDate: Date | null;
    assignedOwnerId: string | null;
    createdByUserId: string;
    deletedAt?: Date | null;
    status?: LicenseStatus | string;
  }) {
    if (license.deletedAt || license.status === 'ARCHIVED') {
      await prisma.complianceEvent.updateMany({
        where: {
          organizationId: license.organizationId,
          sourceType: { in: ['LICENSE_EXPIRY', 'LICENSE_RENEWAL'] },
          sourceId: license.id,
          status: { not: 'COMPLETED' },
        },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      return;
    }

    await this.upsertDateCalendarEvent(license, 'LICENSE_RENEWAL', license.renewalDueDate);
    await this.upsertDateCalendarEvent(license, 'LICENSE_EXPIRY', license.expiryDate);
  }

  private async upsertDateCalendarEvent(
    license: {
      id: string;
      organizationId: string;
      licenseType: string;
      regulator: string;
      licenseNumber: string | null;
      assignedOwnerId: string | null;
      createdByUserId: string;
    },
    sourceType: 'LICENSE_RENEWAL' | 'LICENSE_EXPIRY',
    date: Date | null,
  ) {
    if (!date) {
      await prisma.complianceEvent.deleteMany({
        where: { organizationId: license.organizationId, sourceType, sourceId: license.id },
      });
      return;
    }

    const dueDate = normalizeCalendarDate(date);
    const label = sourceType === 'LICENSE_RENEWAL' ? 'renewal due' : 'expires';
    const numberSuffix = license.licenseNumber ? ` (${license.licenseNumber})` : ` (${license.id.slice(-6)})`;
    const title = `${license.licenseType}${numberSuffix} ${label}`;

    const event = await prisma.complianceEvent.upsert({
      where: {
        organizationId_sourceType_sourceId: {
          organizationId: license.organizationId,
          sourceType,
          sourceId: license.id,
        },
      },
      create: {
        organizationId: license.organizationId,
        title,
        description: `License ${label} for ${license.regulator}.`,
        dueDate,
        priority: sourceType === 'LICENSE_EXPIRY' ? 'CRITICAL' : 'HIGH',
        status: 'UPCOMING',
        category: 'RENEWAL',
        regulation: license.regulator,
        recurrence: 'NONE',
        assigneeId: license.assignedOwnerId,
        createdById: license.createdByUserId,
        sourceType,
        sourceId: license.id,
      },
      update: {
        title,
        description: `License ${label} for ${license.regulator}.`,
        dueDate,
        priority: sourceType === 'LICENSE_EXPIRY' ? 'CRITICAL' : 'HIGH',
        category: 'RENEWAL',
        regulation: license.regulator,
        assigneeId: license.assignedOwnerId,
      },
      select: { id: true },
    });

    await audit({
      userId: license.createdByUserId,
      action: 'license.calendar_event_synced',
      entityType: 'ComplianceEvent',
      entityId: event.id,
      organizationId: license.organizationId,
      metadata: { licenseId: license.id, sourceType },
    });
  }

  async list(params: {
    organizationId: string;
    status?: LicenseStatus;
    search?: string;
    includeArchived?: boolean;
    page: number;
    limit: number;
  }) {
    const where: Prisma.LicenseWhereInput = {
      organizationId: params.organizationId,
      ...(params.includeArchived ? {} : { deletedAt: null, status: { not: LicenseStatus.ARCHIVED } }),
    };

    if (params.status) where.status = params.status;
    if (params.search) {
      where.OR = [
        { licenseType: { contains: params.search, mode: 'insensitive' } },
        { regulator: { contains: params.search, mode: 'insensitive' } },
        { licenseNumber: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    const skip = (params.page - 1) * params.limit;
    const [licenses, total] = await Promise.all([
      prisma.license.findMany({
        where,
        skip,
        take: params.limit,
        orderBy: [{ renewalDueDate: 'asc' }, { expiryDate: 'asc' }, { updatedAt: 'desc' }],
        select: LICENSE_SELECT,
      }),
      prisma.license.count({ where }),
    ]);

    return {
      licenses: licenses.map(withDerivedFields),
      pagination: {
        page: params.page,
        limit: params.limit,
        total,
        pages: Math.ceil(total / params.limit),
      },
    };
  }

  async get(params: { organizationId: string; id: string }) {
    const license = await prisma.license.findFirst({
      where: { id: params.id, organizationId: params.organizationId, deletedAt: null },
      include: LICENSE_DETAIL_INCLUDE,
    });
    if (!license) throw new TRPCError({ code: 'NOT_FOUND', message: 'License not found.' });
    return withDerivedFields(license);
  }

  async create(params: { organizationId: string; actorUserId: string; actorRole: string; input: any }) {
    this.ensureManager(params.actorRole);
    await this.assertAssignableMember(params.organizationId, params.input.assignedOwnerId);

    const license = await prisma.license.create({
      data: {
        licenseType: params.input.licenseType,
        regulator: params.input.regulator,
        licenseNumber: params.input.licenseNumber || null,
        status: params.input.status,
        issueDate: parseDate(params.input.issueDate),
        expiryDate: parseDate(params.input.expiryDate),
        renewalDueDate: parseDate(params.input.renewalDueDate),
        submittedAt: parseDate(params.input.submittedAt),
        approvedAt: parseDate(params.input.approvedAt),
        assignedOwnerId: params.input.assignedOwnerId ?? null,
        notes: params.input.notes,
        organizationId: params.organizationId,
        createdByUserId: params.actorUserId,
      },
    });

    await this.syncLicenseCalendarEvents(license);
    await audit({
      userId: params.actorUserId,
      action: 'license.created',
      entityType: 'License',
      entityId: license.id,
      organizationId: params.organizationId,
      metadata: { status: license.status, assignedOwnerId: license.assignedOwnerId },
    });
    logger.info({ type: 'license_created', organizationId: params.organizationId, licenseId: license.id });
    return this.get({ organizationId: params.organizationId, id: license.id });
  }

  async update(params: { organizationId: string; actorUserId: string; actorRole: string; input: any; adminOverrideReason?: string }) {
    this.ensureManager(params.actorRole);
    await this.requireLicense(params.organizationId, params.input.id);
    await this.assertAssignableMember(params.organizationId, params.input.assignedOwnerId);

    const data: Prisma.LicenseUpdateInput = {
      updatedBy: { connect: { id: params.actorUserId } },
    };
    for (const key of ['licenseType', 'regulator', 'licenseNumber', 'status', 'notes'] as const) {
      if (params.input[key] !== undefined) (data as any)[key] = params.input[key] || null;
    }
    for (const key of ['issueDate', 'expiryDate', 'renewalDueDate', 'submittedAt', 'approvedAt'] as const) {
      if (params.input[key] !== undefined) (data as any)[key] = parseDate(params.input[key]);
    }
    if (params.input.assignedOwnerId !== undefined) {
      data.assignedOwner = params.input.assignedOwnerId
        ? { connect: { id: params.input.assignedOwnerId } }
        : { disconnect: true };
    }

    const license = await prisma.license.update({
      where: { id: params.input.id },
      data,
    });

    await this.syncLicenseCalendarEvents(license);
    await audit({
      userId: params.actorUserId,
      action: params.adminOverrideReason ? 'license.admin_override_updated' : 'license.updated',
      entityType: 'License',
      entityId: license.id,
      organizationId: params.organizationId,
      metadata: { fields: Object.keys(params.input).filter((key) => key !== 'id'), reason: params.adminOverrideReason },
    });
    return this.get({ organizationId: params.organizationId, id: license.id });
  }

  async archive(params: { organizationId: string; actorUserId: string; actorRole: string; id: string }) {
    this.ensureManager(params.actorRole);
    await this.requireLicense(params.organizationId, params.id);
    const license = await prisma.license.update({
      where: { id: params.id },
      data: { status: LicenseStatus.ARCHIVED, deletedAt: new Date(), updatedByUserId: params.actorUserId },
    });
    await this.syncLicenseCalendarEvents(license);
    await audit({
      userId: params.actorUserId,
      action: 'license.archived',
      entityType: 'License',
      entityId: params.id,
      organizationId: params.organizationId,
    });
    return { success: true };
  }

  async addTimelineEvent(params: { organizationId: string; actorUserId: string; actorRole: string; input: any }) {
    this.ensureManager(params.actorRole);
    const license = await this.requireLicense(params.organizationId, params.input.licenseId);
    await this.assertAssignableMember(params.organizationId, params.input.assignedToUserId);
    await this.assertVaultDocument(params.organizationId, params.input.evidenceDocumentId);

    const event = await prisma.licenseTimelineEvent.create({
      data: {
        licenseId: license.id,
        organizationId: params.organizationId,
        eventType: params.input.eventType,
        title: params.input.title,
        description: params.input.description,
        dueDate: parseDate(params.input.dueDate),
        status: params.input.status,
        assignedToUserId: params.input.assignedToUserId ?? null,
        evidenceDocumentId: params.input.evidenceDocumentId ?? null,
        createdByUserId: params.actorUserId,
      },
    });

    if (params.input.createCalendarEvent !== false && event.dueDate) {
      const calendar = await prisma.complianceEvent.upsert({
        where: {
          organizationId_sourceType_sourceId: {
            organizationId: params.organizationId,
            sourceType: 'LICENSE_TIMELINE',
            sourceId: event.id,
          },
        },
        create: {
          organizationId: params.organizationId,
          title: event.title,
          description: event.description,
          dueDate: normalizeCalendarDate(event.dueDate),
          priority: 'MEDIUM',
          status: 'UPCOMING',
          category: 'COMPLIANCE_TASK',
          regulation: license.regulator,
          recurrence: 'NONE',
          assigneeId: event.assignedToUserId,
          createdById: params.actorUserId,
          sourceType: 'LICENSE_TIMELINE',
          sourceId: event.id,
        },
        update: {},
        select: { id: true },
      });
      await prisma.licenseTimelineEvent.update({
        where: { id: event.id },
        data: { complianceEventId: calendar.id },
      });
    }

    await audit({
      userId: params.actorUserId,
      action: 'license.timeline_event_created',
      entityType: 'LicenseTimelineEvent',
      entityId: event.id,
      organizationId: params.organizationId,
      metadata: { licenseId: license.id },
    });
    return this.get({ organizationId: params.organizationId, id: license.id });
  }

  async updateTimelineEvent(params: { organizationId: string; actorUserId: string; actorRole: string; input: any }) {
    this.ensureManager(params.actorRole);
    const existing = await prisma.licenseTimelineEvent.findFirst({
      where: { id: params.input.id, organizationId: params.organizationId, license: { deletedAt: null } },
      select: { id: true, licenseId: true, complianceEventId: true },
    });
    if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Timeline event not found.' });
    await this.assertAssignableMember(params.organizationId, params.input.assignedToUserId);
    await this.assertVaultDocument(params.organizationId, params.input.evidenceDocumentId);

    const data: Prisma.LicenseTimelineEventUpdateInput = { updatedBy: { connect: { id: params.actorUserId } } };
    for (const key of ['eventType', 'title', 'description', 'status'] as const) {
      if (params.input[key] !== undefined) (data as any)[key] = params.input[key];
    }
    if (params.input.dueDate !== undefined) data.dueDate = parseDate(params.input.dueDate);
    if (params.input.assignedToUserId !== undefined) {
      data.assignedTo = params.input.assignedToUserId ? { connect: { id: params.input.assignedToUserId } } : { disconnect: true };
    }
    if (params.input.evidenceDocumentId !== undefined) {
      data.evidenceDocument = params.input.evidenceDocumentId ? { connect: { id: params.input.evidenceDocumentId } } : { disconnect: true };
    }

    const event = await prisma.licenseTimelineEvent.update({ where: { id: existing.id }, data });
    if (event.complianceEventId) {
      if (event.dueDate) {
        await prisma.complianceEvent.update({
          where: { id: event.complianceEventId },
          data: {
            title: event.title,
            description: event.description,
            dueDate: normalizeCalendarDate(event.dueDate),
            assigneeId: event.assignedToUserId,
          },
        });
      } else {
        await prisma.complianceEvent.delete({ where: { id: event.complianceEventId } }).catch(() => undefined);
        await prisma.licenseTimelineEvent.update({ where: { id: event.id }, data: { complianceEventId: null } });
      }
    }

    await audit({
      userId: params.actorUserId,
      action: 'license.timeline_event_updated',
      entityType: 'LicenseTimelineEvent',
      entityId: event.id,
      organizationId: params.organizationId,
      metadata: { licenseId: existing.licenseId },
    });
    return this.get({ organizationId: params.organizationId, id: existing.licenseId });
  }

  async completeTimelineEvent(params: { organizationId: string; actorUserId: string; actorRole: string; id: string }) {
    const existing = await prisma.licenseTimelineEvent.findFirst({
      where: { id: params.id, organizationId: params.organizationId, license: { deletedAt: null } },
      select: { id: true, licenseId: true, assignedToUserId: true, complianceEventId: true },
    });
    if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Timeline event not found.' });
    if (!isManager(params.actorRole) && existing.assignedToUserId !== params.actorUserId) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the assignee or organization admin can complete this timeline event.' });
    }

    const completedAt = new Date();
    await prisma.licenseTimelineEvent.update({
      where: { id: existing.id },
      data: { status: 'COMPLETED', completedAt, updatedByUserId: params.actorUserId },
    });
    if (existing.complianceEventId) {
      await prisma.complianceEvent.update({
        where: { id: existing.complianceEventId },
        data: { status: 'COMPLETED', completedAt },
      });
    }
    await audit({
      userId: params.actorUserId,
      action: 'license.timeline_event_completed',
      entityType: 'LicenseTimelineEvent',
      entityId: existing.id,
      organizationId: params.organizationId,
      metadata: { licenseId: existing.licenseId, calendarEventId: existing.complianceEventId },
    });
    return this.get({ organizationId: params.organizationId, id: existing.licenseId });
  }

  async addDocument(params: { organizationId: string; actorUserId: string; actorRole: string; input: any }) {
    this.ensureManager(params.actorRole);
    await this.requireLicense(params.organizationId, params.input.licenseId);
    await this.assertVaultDocument(params.organizationId, params.input.vaultDocumentId);
    const link = await prisma.licenseDocument.create({
      data: {
        licenseId: params.input.licenseId,
        organizationId: params.organizationId,
        vaultDocumentId: params.input.vaultDocumentId,
        documentType: params.input.documentType,
        notes: params.input.notes,
        createdByUserId: params.actorUserId,
      },
    });
    await audit({
      userId: params.actorUserId,
      action: 'license.document_linked',
      entityType: 'LicenseDocument',
      entityId: link.id,
      organizationId: params.organizationId,
      metadata: { licenseId: params.input.licenseId, vaultDocumentId: params.input.vaultDocumentId },
    });
    return this.get({ organizationId: params.organizationId, id: params.input.licenseId });
  }

  async removeDocument(params: { organizationId: string; actorUserId: string; actorRole: string; id: string }) {
    this.ensureManager(params.actorRole);
    const existing = await prisma.licenseDocument.findFirst({
      where: { id: params.id, organizationId: params.organizationId },
      select: { id: true, licenseId: true, vaultDocumentId: true },
    });
    if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Document link not found.' });
    await prisma.licenseDocument.delete({ where: { id: existing.id } });
    await audit({
      userId: params.actorUserId,
      action: 'license.document_removed',
      entityType: 'LicenseDocument',
      entityId: existing.id,
      organizationId: params.organizationId,
      metadata: { licenseId: existing.licenseId, vaultDocumentId: existing.vaultDocumentId },
    });
    return this.get({ organizationId: params.organizationId, id: existing.licenseId });
  }

  async addFee(params: { organizationId: string; actorUserId: string; actorRole: string; input: any }) {
    this.ensureManager(params.actorRole);
    await this.requireLicense(params.organizationId, params.input.licenseId);
    const fee = await prisma.licenseFee.create({
      data: {
        licenseId: params.input.licenseId,
        organizationId: params.organizationId,
        amount: params.input.amount ?? null,
        currency: params.input.currency,
        description: params.input.description,
        dueDate: parseDate(params.input.dueDate),
        paidAt: parseDate(params.input.paidAt),
        status: params.input.status,
        createdByUserId: params.actorUserId,
      },
    });
    await audit({
      userId: params.actorUserId,
      action: 'license.fee_created',
      entityType: 'LicenseFee',
      entityId: fee.id,
      organizationId: params.organizationId,
      metadata: { licenseId: params.input.licenseId, status: fee.status },
    });
    return this.get({ organizationId: params.organizationId, id: params.input.licenseId });
  }

  async updateFee(params: { organizationId: string; actorUserId: string; actorRole: string; input: any }) {
    this.ensureManager(params.actorRole);
    const existing = await prisma.licenseFee.findFirst({
      where: { id: params.input.id, organizationId: params.organizationId, license: { deletedAt: null } },
      select: { id: true, licenseId: true },
    });
    if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Fee not found.' });
    const data: Prisma.LicenseFeeUpdateInput = { updatedBy: { connect: { id: params.actorUserId } } };
    for (const key of ['amount', 'currency', 'description', 'status'] as const) {
      if (params.input[key] !== undefined) (data as any)[key] = params.input[key];
    }
    for (const key of ['dueDate', 'paidAt'] as const) {
      if (params.input[key] !== undefined) (data as any)[key] = parseDate(params.input[key]);
    }
    const fee = await prisma.licenseFee.update({ where: { id: existing.id }, data });
    await audit({
      userId: params.actorUserId,
      action: 'license.fee_updated',
      entityType: 'LicenseFee',
      entityId: fee.id,
      organizationId: params.organizationId,
      metadata: { licenseId: existing.licenseId, status: fee.status },
    });
    return this.get({ organizationId: params.organizationId, id: existing.licenseId });
  }

  async upcoming(params: { organizationId: string; daysAhead: number }) {
    const now = new Date();
    const horizon = new Date(now.getTime() + params.daysAhead * 24 * 60 * 60 * 1000);
    const licenses = await prisma.license.findMany({
      where: {
        organizationId: params.organizationId,
        deletedAt: null,
        status: { notIn: [LicenseStatus.ARCHIVED, LicenseStatus.REVOKED, LicenseStatus.SUSPENDED] },
        OR: [
          { renewalDueDate: { gte: now, lte: horizon } },
          { expiryDate: { gte: now, lte: horizon } },
        ],
      },
      select: LICENSE_SELECT,
      orderBy: [{ renewalDueDate: 'asc' }, { expiryDate: 'asc' }],
      take: 20,
    });
    return licenses.map(withDerivedFields);
  }

  async summary(params: { organizationId: string }) {
    const [total, active, renewalDueSoon, expired] = await Promise.all([
      prisma.license.count({ where: { organizationId: params.organizationId, deletedAt: null } }),
      prisma.license.count({ where: { organizationId: params.organizationId, deletedAt: null, status: LicenseStatus.ACTIVE } }),
      prisma.license.count({
        where: {
          organizationId: params.organizationId,
          deletedAt: null,
          renewalDueDate: { gte: new Date(), lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
        },
      }),
      prisma.license.count({
        where: {
          organizationId: params.organizationId,
          deletedAt: null,
          OR: [{ status: LicenseStatus.EXPIRED }, { expiryDate: { lt: new Date() } }],
        },
      }),
    ]);
    return { total, active, renewalDueSoon, expired };
  }

  async adminList(params: { actorUserId: string; organizationId?: string; status?: LicenseStatus; search?: string; includeArchived?: boolean; page: number; limit: number }) {
    const where: Prisma.LicenseWhereInput = {
      ...(params.organizationId ? { organizationId: params.organizationId } : {}),
      ...(params.includeArchived ? {} : { deletedAt: null }),
      ...(params.status ? { status: params.status } : {}),
    };
    if (params.search) {
      where.OR = [
        { licenseType: { contains: params.search, mode: 'insensitive' } },
        { regulator: { contains: params.search, mode: 'insensitive' } },
        { licenseNumber: { contains: params.search, mode: 'insensitive' } },
        { organization: { name: { contains: params.search, mode: 'insensitive' } } },
      ];
    }
    const skip = (params.page - 1) * params.limit;
    const [licenses, total] = await Promise.all([
      prisma.license.findMany({
        where,
        skip,
        take: params.limit,
        orderBy: { updatedAt: 'desc' },
        include: {
          organization: { select: { id: true, name: true, plan: true } },
          assignedOwner: { select: { id: true, fullName: true, email: true } },
          _count: { select: { timelineEvents: true, documents: true, fees: true } },
        },
      }),
      prisma.license.count({ where }),
    ]);
    return {
      licenses: licenses.map(withDerivedFields),
      pagination: { page: params.page, limit: params.limit, total, pages: Math.ceil(total / params.limit) },
    };
  }

  async adminGet(params: { actorUserId: string; id: string; reason?: string }) {
    const license = await prisma.license.findFirst({
      where: { id: params.id },
      include: { organization: { select: { id: true, name: true, plan: true } }, ...LICENSE_DETAIL_INCLUDE },
    });
    if (!license) throw new TRPCError({ code: 'NOT_FOUND', message: 'License not found.' });
    await audit({
      userId: params.actorUserId,
      action: 'license.admin_viewed',
      entityType: 'License',
      entityId: params.id,
      organizationId: license.organizationId,
      metadata: { reason: params.reason },
    });
    return withDerivedFields(license);
  }
}

export const licenseService = new LicenseService();
