import { z } from 'zod';
import { TicketCategory, TicketPriority, TicketStatus } from '@prisma/client';

// ── User support schemas ──────────────────────────────────────────────────────

export const createTicketSchema = z.object({
  subject: z.string().min(5, 'Subject must be at least 5 characters').max(200),
  description: z.string().min(20, 'Description must be at least 20 characters').max(5000),
  category: z.nativeEnum(TicketCategory),
  priority: z.nativeEnum(TicketPriority).optional().default('MEDIUM'),
});

export const listTicketsSchema = z.object({
  status: z.nativeEnum(TicketStatus).optional(),
  page: z.number().int().positive().optional().default(1),
  limit: z.number().int().positive().max(50).optional().default(10),
});

export const getTicketByNumberSchema = z.object({
  ticketNumber: z.string().regex(/^SB-\d{4}-\d{5}$/, 'Invalid ticket number format'),
});

export const addCommentSchema = z.object({
  ticketId: z.string().cuid(),
  message: z.string().min(1, 'Message cannot be empty').max(5000),
});

// ── Admin support schemas ─────────────────────────────────────────────────────

export const adminListTicketsSchema = z.object({
  status: z.nativeEnum(TicketStatus).optional(),
  priority: z.nativeEnum(TicketPriority).optional(),
  category: z.nativeEnum(TicketCategory).optional(),
  search: z.string().optional(),
  page: z.number().int().positive().optional().default(1),
  limit: z.number().int().positive().max(50).optional().default(20),
});

export const adminUpdateStatusSchema = z.object({
  ticketId: z.string().cuid(),
  status: z.nativeEnum(TicketStatus),
});

export const adminAddResponseSchema = z.object({
  ticketId: z.string().cuid(),
  message: z.string().min(1).max(5000),
  updateStatusTo: z.nativeEnum(TicketStatus).optional(),
});
