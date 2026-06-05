import { TRPCError } from '@trpc/server';
import { MemberRole, MemberStatus, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import { notificationModule } from '@/modules/notification';
import type {
  CalendarEventRecord,
  CreateEventParams,
  ListEventsParams,
  GetEventParams,
  UpdateEventParams,
  DeleteEventParams,
  UpcomingEventsParams,
} from './calendar.types';

// --- Prisma select shared across all queries ----------------------------------

const CALENDAR_EVENT_SELECT = {
  id:             true,
  organizationId: true,
  title:          true,
  description:    true,
  dueDate:        true,
  priority:       true,
  status:         true,
  category:       true,
  regulation:     true,
  recurrence:     true,
  assigneeId:     true,
  createdById:    true,
  completedAt:    true,
  createdAt:      true,
  updatedAt:      true,
} as const;

// --- Reminder thresholds (days before due date) --------------------------------

const REMINDER_THRESHOLDS = [7, 3, 1, 0] as const;

// --- Helpers ------------------------------------------------------------------

function formatEventDate(date: Date): string {
  return date.toLocaleDateString('en-KE', { dateStyle: 'medium' });
}

function reminderCheckKey(organizationId: string): string {
  return `calendar-reminder-check:${organizationId}`;
}

// 15-minute TTL for the reminder evaluation throttle
const REMINDER_THROTTLE_SECONDS = 900;

const CALENDAR_MANAGER_ROLES = new Set<string>([MemberRole.OWNER, MemberRole.ADMIN]);

function isCalendarManager(role: string): boolean {
  return CALENDAR_MANAGER_ROLES.has(role);
}

function isAssignedCompletionUpdate(input: UpdateEventParams): boolean {
  const allowedKeys = new Set(['id', 'organizationId', 'actorUserId', 'actorRole', 'status']);
  return input.status === 'COMPLETED' && Object.keys(input).every((key) => allowedKeys.has(key));
}

class CalendarModule {
  private async assertAssignableMember(organizationId: string, assigneeId: string | undefined): Promise<void> {
    if (!assigneeId) return;

    const member = await prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId: assigneeId, organizationId } },
      select: { status: true },
    });

    if (!member || member.status !== MemberStatus.ACTIVE) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Assigned user must be an active member of this organization.',
      });
    }
  }

  // --- createEvent -----------------------------------------------------------

  async createEvent(params: CreateEventParams): Promise<CalendarEventRecord> {
    const {
      organizationId, createdById, title, description,
      dueDate, priority, category, regulation, recurrence, assigneeId,
    } = params;

    // Normalize to UTC midnight so the @@unique constraint is effective and
    // the duplicate guard works regardless of what time-of-day is submitted.
    const normalizedDate = new Date(dueDate);
    normalizedDate.setUTCHours(0, 0, 0, 0);

    await this.assertAssignableMember(organizationId, assigneeId);

    // -- Duplicate guard (Task 2) ---------------------------------------------
    // Use a same-day window in case legacy records predate the unique constraint.
    const dayStart = new Date(normalizedDate);
    const dayEnd   = new Date(normalizedDate);
    dayEnd.setUTCHours(23, 59, 59, 999);

    const duplicate = await prisma.complianceEvent.findFirst({
      where: {
        organizationId,
        title: { equals: title, mode: 'insensitive' },
        dueDate: { gte: dayStart, lte: dayEnd },
      },
      select: { id: true },
    });

    if (duplicate) {
      logger.warn({
        type: 'calendar_duplicate_blocked',
        organizationId,
        title,
        dueDate: normalizedDate.toISOString(),
      });
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'A compliance event with this title already exists for the selected date. Please use a different title or choose another date.',
      });
    }

    // -- Create ---------------------------------------------------------------
    let event: CalendarEventRecord;

    try {
      event = await prisma.complianceEvent.create({
        data: {
          organizationId,
          createdById,
          title,
          description,
          dueDate:    normalizedDate,
          priority,
          status:     'UPCOMING',
          category,
          regulation,
          recurrence,
          assigneeId,
        },
        select: CALENDAR_EVENT_SELECT,
      });
    } catch (err: unknown) {
      // Catch race-condition where two requests pass the findFirst check simultaneously
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'A compliance event with this title already exists for the selected date. Please use a different title or choose another date.',
        });
      }
      throw err;
    }

    logger.info({
      type:           'calendar_event_created',
      eventId:        event.id,
      organizationId,
      createdById,
      category,
      priority,
    });

    // -- EVENT_CREATED notification (Task 6)  -  fire-and-forget ----------------
    void notificationModule.createNotification({
      userId:   createdById,
      type:     'EVENT_CREATED',
      category: 'COMPLIANCE',
      title:    `Event Created: ${title}`,
      message:  `The compliance event "${title}" has been scheduled for ${formatEventDate(normalizedDate)}.`,
      link:     '/startup/calendar',
      eventId:  event.id,
      metadata: { eventTitle: title, dueDate: normalizedDate.toISOString() },
    }).catch((err: unknown) => {
      logger.error({
        type:    'calendar_event_created_notification_failed',
        eventId: event.id,
        error:   String(err),
      });
    });

    return event;
  }

  // --- listEvents -----------------------------------------------------------

  async listEvents(params: ListEventsParams): Promise<CalendarEventRecord[]> {
    const { organizationId, month, year, status, priority } = params;

    // Build optional date-range filter when month/year are supplied
    let dateFilter: { gte?: Date; lte?: Date } | undefined;
    if (month !== undefined && year !== undefined) {
      const start = new Date(year, month - 1, 1);
      const end   = new Date(year, month, 0, 23, 59, 59, 999);
      dateFilter  = { gte: start, lte: end };
    } else if (year !== undefined) {
      const start = new Date(year, 0, 1);
      const end   = new Date(year, 11, 31, 23, 59, 59, 999);
      dateFilter  = { gte: start, lte: end };
    }

    const events = await prisma.complianceEvent.findMany({
      where: {
        organizationId,
        ...(dateFilter  ? { dueDate:  dateFilter } : {}),
        ...(status      ? { status }               : {}),
        ...(priority    ? { priority }             : {}),
      },
      select:  CALENDAR_EVENT_SELECT,
      orderBy: { dueDate: 'asc' },
    });

    return events;
  }

  // --- getEvent -------------------------------------------------------------

  async getEvent(params: GetEventParams): Promise<CalendarEventRecord> {
    const { id, organizationId } = params;

    const event = await prisma.complianceEvent.findFirst({
      where:  { id, organizationId },
      select: CALENDAR_EVENT_SELECT,
    });

    if (!event) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found.' });
    }

    return event;
  }

  // --- updateEvent ----------------------------------------------------------

  async updateEvent(params: UpdateEventParams): Promise<CalendarEventRecord> {
    const { id, organizationId, actorUserId, actorRole, dueDate, status, assigneeId, ...rest } = params;

    // Ensure the event belongs to the caller's org before mutating
    const existing = await prisma.complianceEvent.findFirst({
      where:  { id, organizationId },
      select: { id: true, assigneeId: true },
    });

    if (!existing) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found.' });
    }

    const manager = isCalendarManager(actorRole);
    if (!manager) {
      if (!isAssignedCompletionUpdate(params) || existing.assigneeId !== actorUserId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only organization owners and admins can manage compliance calendar events.',
        });
      }
    }

    await this.assertAssignableMember(organizationId, assigneeId);

    const updateData: Record<string, unknown> = { ...rest };

    if (assigneeId !== undefined) {
      updateData['assigneeId'] = assigneeId;
    }

    if (dueDate !== undefined) {
      const normalized = new Date(dueDate);
      normalized.setUTCHours(0, 0, 0, 0);
      updateData['dueDate'] = normalized;
    }

    if (status !== undefined) {
      updateData['status'] = status;
      if (status === 'COMPLETED') {
        updateData['completedAt'] = new Date();
      }
    }

    const event = await prisma.complianceEvent.update({
      where:  { id },
      data:   updateData,
      select: CALENDAR_EVENT_SELECT,
    });

    logger.info({ type: 'calendar_event_updated', eventId: id, organizationId, changes: Object.keys(updateData) });

    return event;
  }

  // --- deleteEvent ----------------------------------------------------------

  async deleteEvent(params: DeleteEventParams): Promise<{ id: string }> {
    const { id, organizationId } = params;

    const existing = await prisma.complianceEvent.findFirst({
      where:  { id, organizationId },
      select: { id: true },
    });

    if (!existing) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found.' });
    }

    await prisma.complianceEvent.delete({ where: { id } });

    logger.info({ type: 'calendar_event_deleted', eventId: id, organizationId });

    return { id };
  }

  // --- getUpcomingDeadlines -------------------------------------------------

  async getUpcomingDeadlines(params: UpcomingEventsParams): Promise<CalendarEventRecord[]> {
    const { organizationId, daysAhead } = params;

    const now    = new Date();
    const cutoff = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

    const events = await prisma.complianceEvent.findMany({
      where: {
        organizationId,
        dueDate: { gte: now, lte: cutoff },
        status:  { in: ['UPCOMING', 'IN_PROGRESS'] },
      },
      select:  CALENDAR_EVENT_SELECT,
      orderBy: { dueDate: 'asc' },
      take:    10,
    });

    return events;
  }

  // --- evaluateAndGenerateReminders (Task 5) --------------------------------
  //
  // Lazy evaluation: called fire-and-forget from the upcoming query router.
  // Checks Redis to avoid running more than once every 15 minutes per org.
  // For each event due within 7 days, generates missing reminder notifications
  // at each configured threshold (7d, 3d, 1d, 0d).

  async evaluateAndGenerateReminders(organizationId: string): Promise<void> {
    // -- Throttle check -------------------------------------------------------
    const throttleKey = reminderCheckKey(organizationId);
    const alreadyRan  = await redis.get<string>(throttleKey);
    if (alreadyRan) return;

    // Set the throttle key immediately to prevent concurrent evaluations
    await redis.set(throttleKey, '1', { ex: REMINDER_THROTTLE_SECONDS });

    // -- Fetch events due within the next 7 days -------------------------------
    const now      = new Date();
    const horizon  = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const events = await prisma.complianceEvent.findMany({
      where: {
        organizationId,
        dueDate: { gte: now, lte: horizon },
        status:  { notIn: ['COMPLETED', 'OVERDUE'] },
      },
      select: {
        id:          true,
        title:       true,
        dueDate:     true,
        createdById: true,
      },
    });

    if (events.length === 0) return;

    let remindersGenerated = 0;

    for (const event of events) {
      const dueDateMs = new Date(event.dueDate).getTime();

      for (const threshold of REMINDER_THRESHOLDS) {
        const thresholdMs = dueDateMs - threshold * 24 * 60 * 60 * 1000;

        // Only fire if we have passed the threshold window
        if (now.getTime() < thresholdMs) continue;

        // Check if this reminder already exists for this event + threshold
        const existing = await prisma.notification.findFirst({
          where: {
            userId:  event.createdById,
            eventId: event.id,
            type:    'EVENT_REMINDER',
            metadata: {
              path:   ['threshold'],
              equals: threshold,
            },
          },
          select: { id: true },
        });

        if (existing) continue;

        const title = threshold === 0
          ? `Due Today: ${event.title}`
          : `Upcoming: ${event.title}  -  ${threshold} day${threshold > 1 ? 's' : ''} remaining`;

        await notificationModule.createNotification({
          userId:   event.createdById,
          type:     'EVENT_REMINDER',
          category: 'COMPLIANCE',
          title,
          message:  `The compliance event "${event.title}" is due on ${formatEventDate(new Date(event.dueDate))}.`,
          link:     '/startup/calendar',
          eventId:  event.id,
          metadata: { threshold },
        });

        remindersGenerated += 1;
      }
    }

    if (remindersGenerated > 0) {
      logger.info({
        type:               'calendar_reminders_generated',
        organizationId,
        remindersGenerated,
      });
    }
  }
}

export const calendarModule = new CalendarModule();
export { CalendarModule };
