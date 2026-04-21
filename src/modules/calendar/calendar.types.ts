import type { EventPriority, EventStatus, EventCategory, EventRecurrence } from '@/server/schemas/calendar.schema';

// --- Prisma select shape (returned by all queries) ---------------------------

export interface CalendarEventRecord {
  id:             string;
  organizationId: string;
  title:          string;
  description:    string | null;
  dueDate:        Date;
  priority:       string;
  status:         string;
  category:       string;
  regulation:     string | null;
  recurrence:     string | null;
  assigneeId:     string | null;
  createdById:    string;
  completedAt:    Date | null;
  createdAt:      Date;
  updatedAt:      Date;
}

// --- Method input shapes -----------------------------------------------------

export interface CreateEventParams {
  organizationId: string;
  createdById:    string;
  title:          string;
  description?:   string;
  dueDate:        string; // ISO string  -  converted to Date in service
  priority:       EventPriority;
  category:       EventCategory;
  regulation?:    string;
  recurrence:     EventRecurrence;
  assigneeId?:    string;
}

export interface ListEventsParams {
  organizationId: string;
  month?:         number;
  year?:          number;
  status?:        EventStatus;
  priority?:      EventPriority;
}

export interface GetEventParams {
  id:             string;
  organizationId: string;
}

export interface UpdateEventParams {
  id:             string;
  organizationId: string;
  title?:         string;
  description?:   string;
  dueDate?:       string;
  priority?:      EventPriority;
  status?:        EventStatus;
  category?:      EventCategory;
  regulation?:    string;
  recurrence?:    EventRecurrence;
  assigneeId?:    string;
}

export interface DeleteEventParams {
  id:             string;
  organizationId: string;
}

export interface UpcomingEventsParams {
  organizationId: string;
  daysAhead:      number;
}
