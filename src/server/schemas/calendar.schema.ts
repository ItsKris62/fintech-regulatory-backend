import { z } from 'zod';

// --- Enums (kept as const arrays so frontend can import them too) -------------

export const EVENT_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const EVENT_STATUSES   = ['UPCOMING', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE'] as const;
export const EVENT_CATEGORIES = ['CUSTOM', 'FILING', 'AUDIT', 'RENEWAL', 'REVIEW'] as const;
export const EVENT_RECURRENCES = ['NONE', 'MONTHLY', 'QUARTERLY', 'ANNUALLY'] as const;

export type EventPriority   = typeof EVENT_PRIORITIES[number];
export type EventStatus     = typeof EVENT_STATUSES[number];
export type EventCategory   = typeof EVENT_CATEGORIES[number];
export type EventRecurrence = typeof EVENT_RECURRENCES[number];

// --- Create -------------------------------------------------------------------

export const createComplianceEventSchema = z.object({
  title:       z.string().min(1, 'Title is required').max(200),
  description: z.string().max(2000).optional(),
  dueDate:     z.string().datetime({ message: 'Invalid date format  -  use ISO 8601' }),
  priority:    z.enum(EVENT_PRIORITIES).default('MEDIUM'),
  category:    z.enum(EVENT_CATEGORIES).default('CUSTOM'),
  regulation:  z.string().max(200).optional(),
  recurrence:  z.enum(EVENT_RECURRENCES).default('NONE'),
  assigneeId:  z.string().cuid({ message: 'Invalid assignee ID' }).optional(),
});

export type CreateComplianceEventInput = z.infer<typeof createComplianceEventSchema>;

// --- Update -------------------------------------------------------------------

export const updateComplianceEventSchema = z.object({
  id:          z.string().cuid(),
  title:       z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  dueDate:     z.string().datetime().optional(),
  priority:    z.enum(EVENT_PRIORITIES).optional(),
  status:      z.enum(EVENT_STATUSES).optional(),
  category:    z.enum(EVENT_CATEGORIES).optional(),
  regulation:  z.string().max(200).optional(),
  recurrence:  z.enum(EVENT_RECURRENCES).optional(),
  assigneeId:  z.string().cuid().optional(),
});

export type UpdateComplianceEventInput = z.infer<typeof updateComplianceEventSchema>;

// --- List / filter ------------------------------------------------------------

export const listComplianceEventsSchema = z.object({
  month:    z.number().int().min(1).max(12).optional(),
  year:     z.number().int().min(2020).max(2100).optional(),
  status:   z.enum(EVENT_STATUSES).optional(),
  priority: z.enum(EVENT_PRIORITIES).optional(),
});

export type ListComplianceEventsInput = z.infer<typeof listComplianceEventsSchema>;

// --- Single event -------------------------------------------------------------

export const getComplianceEventSchema = z.object({
  id: z.string().cuid(),
});

// --- Delete -------------------------------------------------------------------

export const deleteComplianceEventSchema = z.object({
  id: z.string().cuid(),
});

// --- Upcoming deadlines -------------------------------------------------------

export const upcomingEventsSchema = z.object({
  daysAhead: z.number().int().min(1).max(365).optional().default(30),
});
