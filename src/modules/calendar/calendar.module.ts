import { TRPCError } from '@trpc/server';
import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import type {
  CalendarEventRecord,
  CreateEventParams,
  ListEventsParams,
  GetEventParams,
  UpdateEventParams,
  DeleteEventParams,
  UpcomingEventsParams,
} from './calendar.types';

// ─── Prisma select shared across all queries ──────────────────────────────────

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

class CalendarModule {
  // ─── createEvent ───────────────────────────────────────────────────────────

  async createEvent(params: CreateEventParams): Promise<CalendarEventRecord> {
    const {
      organizationId, createdById, title, description,
      dueDate, priority, category, regulation, recurrence, assigneeId,
    } = params;

    const event = await prisma.complianceEvent.create({
      data: {
        organizationId,
        createdById,
        title,
        description,
        dueDate:    new Date(dueDate),
        priority,
        status:     'UPCOMING',
        category,
        regulation,
        recurrence,
        assigneeId,
      },
      select: CALENDAR_EVENT_SELECT,
    });

    logger.info({
      type:           'calendar_event_created',
      eventId:        event.id,
      organizationId,
      createdById,
      category,
      priority,
    });

    return event;
  }

  // ─── listEvents ───────────────────────────────────────────────────────────

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

  // ─── getEvent ─────────────────────────────────────────────────────────────

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

  // ─── updateEvent ──────────────────────────────────────────────────────────

  async updateEvent(params: UpdateEventParams): Promise<CalendarEventRecord> {
    const { id, organizationId, dueDate, status, ...rest } = params;

    // Ensure the event belongs to the caller's org before mutating
    const existing = await prisma.complianceEvent.findFirst({
      where:  { id, organizationId },
      select: { id: true },
    });

    if (!existing) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found.' });
    }

    const updateData: Record<string, unknown> = { ...rest };

    if (dueDate !== undefined) {
      updateData['dueDate'] = new Date(dueDate);
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

  // ─── deleteEvent ──────────────────────────────────────────────────────────

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

  // ─── getUpcomingDeadlines ─────────────────────────────────────────────────

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
}

export const calendarModule = new CalendarModule();
export { CalendarModule };
