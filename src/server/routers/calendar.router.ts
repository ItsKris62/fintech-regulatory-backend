import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc/trpc';
import { withPlanContext, requirePlanFeature } from '../trpc/middleware';
import { calendarModule } from '@/modules/calendar';
import {
  createComplianceEventSchema,
  updateComplianceEventSchema,
  listComplianceEventsSchema,
  getComplianceEventSchema,
  deleteComplianceEventSchema,
  upcomingEventsSchema,
} from '../schemas/calendar.schema';
import { logger } from '@/utils/logger';

/**
 * Calendar Router
 *
 * Thin tRPC layer for the organisation-scoped Compliance Calendar.
 * All business logic lives in CalendarModule.
 *
 * All queries/mutations are scoped to ctx.user.organizationId so no
 * org ID is required in the input — multi-tenant isolation is enforced here.
 */
export const calendarRouter = router({
  /**
   * Create a new compliance event.
   * Requires complianceCalendar feature on the org's plan.
   */
  create: protectedProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('complianceCalendar'))
    .input(createComplianceEventSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        return await calendarModule.createEvent({
          organizationId: ctx.user.organizationId ?? '',
          createdById:    ctx.user.id,
          title:          input.title,
          description:    input.description,
          dueDate:        input.dueDate,
          priority:       input.priority,
          category:       input.category,
          regulation:     input.regulation,
          recurrence:     input.recurrence,
          assigneeId:     input.assigneeId,
        });
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        logger.error({ type: 'calendar_create_error', userId: ctx.user.id, error: String(error) });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create event.' });
      }
    }),

  /**
   * List events for the calendar grid — filtered by month/year and optional
   * status/priority filters.
   */
  list: protectedProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('complianceCalendar'))
    .input(listComplianceEventsSchema)
    .query(async ({ input, ctx }) => {
      try {
        return await calendarModule.listEvents({
          organizationId: ctx.user.organizationId ?? '',
          month:          input.month,
          year:           input.year,
          status:         input.status,
          priority:       input.priority,
        });
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        logger.error({ type: 'calendar_list_error', userId: ctx.user.id, error: String(error) });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to load events.' });
      }
    }),

  /**
   * Fetch a single event by ID (org-scoped).
   */
  get: protectedProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('complianceCalendar'))
    .input(getComplianceEventSchema)
    .query(async ({ input, ctx }) => {
      try {
        return await calendarModule.getEvent({
          id:             input.id,
          organizationId: ctx.user.organizationId ?? '',
        });
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        logger.error({ type: 'calendar_get_error', userId: ctx.user.id, eventId: input.id, error: String(error) });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch event.' });
      }
    }),

  /**
   * Update an existing event (partial — only provided fields are changed).
   */
  update: protectedProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('complianceCalendar'))
    .input(updateComplianceEventSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const { id, ...rest } = input;
        return await calendarModule.updateEvent({
          id,
          organizationId: ctx.user.organizationId ?? '',
          ...rest,
        });
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        logger.error({ type: 'calendar_update_error', userId: ctx.user.id, eventId: input.id, error: String(error) });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to update event.' });
      }
    }),

  /**
   * Hard-delete an event (org-scoped ownership check in module).
   */
  delete: protectedProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('complianceCalendar'))
    .input(deleteComplianceEventSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        return await calendarModule.deleteEvent({
          id:             input.id,
          organizationId: ctx.user.organizationId ?? '',
        });
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        logger.error({ type: 'calendar_delete_error', userId: ctx.user.id, eventId: input.id, error: String(error) });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to delete event.' });
      }
    }),

  /**
   * Upcoming deadlines for the sidebar (events due within daysAhead days).
   */
  upcoming: protectedProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('complianceCalendar'))
    .input(upcomingEventsSchema)
    .query(async ({ input, ctx }) => {
      const organizationId = ctx.user.organizationId ?? '';
      try {
        const events = await calendarModule.getUpcomingDeadlines({
          organizationId,
          daysAhead: input.daysAhead,
        });

        // Fire-and-forget lazy reminder evaluation — does not block the response
        void calendarModule.evaluateAndGenerateReminders(organizationId).catch((err: unknown) => {
          logger.error({ type: 'calendar_reminder_eval_error', organizationId, error: String(err) });
        });

        return events;
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        logger.error({ type: 'calendar_upcoming_error', userId: ctx.user.id, error: String(error) });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to load upcoming events.' });
      }
    }),
});
