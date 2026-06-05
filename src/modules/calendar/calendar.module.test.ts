import { MemberRole, MemberStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CalendarModule } from './calendar.module';
import { prisma } from '@/lib/prisma/client';

vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    organizationMember: {
      findUnique: vi.fn(),
    },
    complianceEvent: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    notification: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

vi.mock('@/modules/notification', () => ({
  notificationModule: {
    createNotification: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const module = new CalendarModule();
const dueDateIso = '2026-07-15T00:00:00.000Z';

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event_1',
    organizationId: 'org_1',
    title: 'License renewal',
    description: null,
    dueDate: new Date(dueDateIso),
    priority: 'HIGH',
    status: 'UPCOMING',
    category: 'RENEWAL',
    regulation: null,
    recurrence: 'NONE',
    assigneeId: null,
    createdById: 'owner_1',
    completedAt: null,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('CalendarModule hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.complianceEvent.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.organizationMember.findUnique).mockResolvedValue({
      status: MemberStatus.ACTIVE,
    } as any);
  });

  it('creates license-friendly calendar events for active same-organization assignees', async () => {
    vi.mocked(prisma.complianceEvent.create).mockResolvedValue(event({
      category: 'REGULATORY_DEADLINE',
      assigneeId: 'member_1',
    }) as any);

    await expect(module.createEvent({
      organizationId: 'org_1',
      createdById: 'owner_1',
      title: 'CBK license filing',
      dueDate: dueDateIso,
      priority: 'HIGH',
      category: 'REGULATORY_DEADLINE',
      recurrence: 'NONE',
      assigneeId: 'member_1',
    })).resolves.toMatchObject({
      category: 'REGULATORY_DEADLINE',
      assigneeId: 'member_1',
    });

    expect(prisma.organizationMember.findUnique).toHaveBeenCalledWith({
      where: { userId_organizationId: { userId: 'member_1', organizationId: 'org_1' } },
      select: { status: true },
    });
  });

  it('blocks assignment to a missing or removed organization member', async () => {
    vi.mocked(prisma.organizationMember.findUnique).mockResolvedValueOnce({
      status: MemberStatus.REMOVED,
    } as any);

    await expect(module.createEvent({
      organizationId: 'org_1',
      createdById: 'owner_1',
      title: 'Document expiry',
      dueDate: dueDateIso,
      priority: 'MEDIUM',
      category: 'DOCUMENT_EXPIRY',
      recurrence: 'NONE',
      assigneeId: 'removed_member',
    })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Assigned user must be an active member of this organization.',
    });

    expect(prisma.complianceEvent.create).not.toHaveBeenCalled();
  });

  it('blocks members from updating event details', async () => {
    vi.mocked(prisma.complianceEvent.findFirst).mockResolvedValueOnce({
      id: 'event_1',
      assigneeId: 'member_1',
    } as any);

    await expect(module.updateEvent({
      id: 'event_1',
      organizationId: 'org_1',
      actorUserId: 'member_1',
      actorRole: MemberRole.MEMBER,
      title: 'Changed title',
    })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    expect(prisma.complianceEvent.update).not.toHaveBeenCalled();
  });

  it('allows an assigned member to mark only their own event complete', async () => {
    vi.mocked(prisma.complianceEvent.findFirst).mockResolvedValueOnce({
      id: 'event_1',
      assigneeId: 'member_1',
    } as any);
    vi.mocked(prisma.complianceEvent.update).mockResolvedValueOnce(event({
      assigneeId: 'member_1',
      status: 'COMPLETED',
      completedAt: new Date('2026-06-05T00:00:00.000Z'),
    }) as any);

    await expect(module.updateEvent({
      id: 'event_1',
      organizationId: 'org_1',
      actorUserId: 'member_1',
      actorRole: MemberRole.MEMBER,
      status: 'COMPLETED',
    })).resolves.toMatchObject({
      status: 'COMPLETED',
      assigneeId: 'member_1',
    });

    expect(prisma.complianceEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'event_1' },
        data: expect.objectContaining({
          status: 'COMPLETED',
          completedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('blocks unassigned members from completing another member event', async () => {
    vi.mocked(prisma.complianceEvent.findFirst).mockResolvedValueOnce({
      id: 'event_1',
      assigneeId: 'member_2',
    } as any);

    await expect(module.updateEvent({
      id: 'event_1',
      organizationId: 'org_1',
      actorUserId: 'member_1',
      actorRole: MemberRole.MEMBER,
      status: 'COMPLETED',
    })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    expect(prisma.complianceEvent.update).not.toHaveBeenCalled();
  });

  it('allows owners and admins to update details and assign active org members', async () => {
    vi.mocked(prisma.complianceEvent.findFirst).mockResolvedValueOnce({
      id: 'event_1',
      assigneeId: null,
    } as any);
    vi.mocked(prisma.complianceEvent.update).mockResolvedValueOnce(event({
      assigneeId: 'member_1',
      category: 'COMPLIANCE_TASK',
    }) as any);

    await expect(module.updateEvent({
      id: 'event_1',
      organizationId: 'org_1',
      actorUserId: 'admin_1',
      actorRole: MemberRole.ADMIN,
      category: 'COMPLIANCE_TASK',
      assigneeId: 'member_1',
    })).resolves.toMatchObject({
      category: 'COMPLIANCE_TASK',
      assigneeId: 'member_1',
    });
  });

  it('does not update events outside the caller organization', async () => {
    vi.mocked(prisma.complianceEvent.findFirst).mockResolvedValueOnce(null);

    await expect(module.updateEvent({
      id: 'event_org_b',
      organizationId: 'org_1',
      actorUserId: 'admin_1',
      actorRole: MemberRole.ADMIN,
      title: 'Cross-org edit',
    })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('queries upcoming deadlines by organization, window, and active statuses', async () => {
    vi.mocked(prisma.complianceEvent.findMany).mockResolvedValueOnce([event()] as any);

    await module.getUpcomingDeadlines({
      organizationId: 'org_1',
      daysAhead: 30,
    });

    expect(prisma.complianceEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org_1',
          dueDate: expect.objectContaining({
            gte: expect.any(Date),
            lte: expect.any(Date),
          }),
          status: { in: ['UPCOMING', 'IN_PROGRESS'] },
        }),
        take: 10,
      }),
    );
  });
});
