/**
 * Support Ticket Service
 *
 * All business logic for support ticket operations.
 * tRPC routers are thin wrappers that call these functions.
 */

import { TRPCError } from '@trpc/server';
import type { TicketCategory, TicketPriority, TicketStatus } from '@prisma/client';
import { logger } from '@/utils/logger';
import { notificationModule } from '@/modules/notification';
import { reactMailer } from '@/lib/email/react-mailer.service';
import { appConfig } from '@/config/app.config';
import { generateTicketNumber } from './generateTicketNumber';

// ── Input Types ───────────────────────────────────────────────────────────────

export interface CreateTicketInput {
  subject: string;
  description: string;
  category: TicketCategory;
  priority?: TicketPriority;
}

export interface ListTicketsFilters {
  status?: TicketStatus;
  page?: number;
  limit?: number;
}

export interface AdminListTicketsFilters {
  status?: TicketStatus;
  priority?: TicketPriority;
  category?: TicketCategory;
  search?: string;
  page?: number;
  limit?: number;
}

// ── User Operations ───────────────────────────────────────────────────────────

export async function createTicket(
  prisma: any,
  userId: string,
  input: CreateTicketInput
) {
  // Wrap in transaction to prevent ticket number race conditions
  const ticket = await prisma.$transaction(async (tx: any) => {
    const ticketNumber = await generateTicketNumber(tx);
    return tx.supportTicket.create({
      data: {
        ticketNumber,
        userId,
        subject: input.subject,
        description: input.description,
        category: input.category,
        priority: input.priority ?? 'MEDIUM',
        status: 'OPEN',
      },
    });
  });

  logger.info({ type: 'support_ticket_created', ticketNumber: ticket.ticketNumber, userId });

  // Fetch user for email
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, fullName: true },
  });

  // In-app notification (non-blocking)
  notificationModule.createNotification({
    userId,
    type: 'TICKET_CREATED',
    title: `Ticket ${ticket.ticketNumber} Received`,
    message: `Your support request "${ticket.subject}" has been received. We'll get back to you shortly.`,
    link: `/support/${ticket.ticketNumber}`,
    metadata: { ticketNumber: ticket.ticketNumber },
  }).catch((err: Error) => {
    logger.warn({ type: 'ticket_notification_failed', ticketNumber: ticket.ticketNumber, error: err.message });
  });

  // Emails (non-blocking)
  if (user) {
    reactMailer.sendTicketConfirmationEmail(user.email, {
      ticketNumber: ticket.ticketNumber,
      subject: ticket.subject,
      userName: user.fullName,
      category: ticket.category,
      priority: ticket.priority,
    }).catch((err: Error) => {
      logger.warn({ type: 'ticket_confirmation_email_failed', ticketNumber: ticket.ticketNumber, error: err.message });
    });

    reactMailer.sendNewTicketAdminEmail(appConfig.email.supportRecipient, {
      ticketNumber: ticket.ticketNumber,
      subject: ticket.subject,
      userName: user.fullName,
      userEmail: user.email,
      category: ticket.category,
      priority: ticket.priority,
      description: ticket.description,
    }).catch((err: Error) => {
      logger.warn({ type: 'ticket_admin_email_failed', ticketNumber: ticket.ticketNumber, error: err.message });
    });
  }

  return ticket;
}

export async function getUserTickets(
  prisma: any,
  userId: string,
  filters: ListTicketsFilters
) {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 10;
  const skip = (page - 1) * limit;

  const where = {
    userId,
    ...(filters.status && { status: filters.status }),
  };

  const [tickets, total] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      include: { _count: { select: { comments: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.supportTicket.count({ where }),
  ]);

  return {
    tickets,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

export async function getTicketDetail(
  prisma: any,
  ticketNumber: string,
  userId: string
) {
  const ticket = await prisma.supportTicket.findUnique({
    where: { ticketNumber },
    include: {
      comments: {
        include: {
          user: { select: { id: true, fullName: true, email: true, role: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!ticket || ticket.userId !== userId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Ticket not found' });
  }

  return ticket;
}

export async function addUserComment(
  prisma: any,
  ticketId: string,
  userId: string,
  message: string
) {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: { id: true, userId: true, status: true },
  });

  if (!ticket || ticket.userId !== userId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Ticket not found' });
  }

  if (ticket.status === 'CLOSED') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Cannot add comment to a closed ticket' });
  }

  const [comment] = await Promise.all([
    prisma.ticketComment.create({
      data: { ticketId, userId, message, isAdmin: false },
      include: { user: { select: { id: true, fullName: true, email: true, role: true } } },
    }),
    // If ticket was awaiting user response, move it back to in-progress
    ticket.status === 'AWAITING_USER'
      ? prisma.supportTicket.update({ where: { id: ticketId }, data: { status: 'IN_PROGRESS' } })
      : Promise.resolve(),
  ]);

  return comment;
}

// ── Admin Operations ──────────────────────────────────────────────────────────

export async function getAdminTickets(
  prisma: any,
  filters: AdminListTicketsFilters
) {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 20;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {};
  if (filters.status) where.status = filters.status;
  if (filters.priority) where.priority = filters.priority;
  if (filters.category) where.category = filters.category;
  if (filters.search) {
    where.OR = [
      { ticketNumber: { contains: filters.search, mode: 'insensitive' } },
      { subject: { contains: filters.search, mode: 'insensitive' } },
    ];
  }

  const [tickets, total] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      include: {
        user: { select: { id: true, fullName: true, email: true, role: true } },
        _count: { select: { comments: true } },
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      skip,
      take: limit,
    }),
    prisma.supportTicket.count({ where }),
  ]);

  return { tickets, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getAdminTicketDetail(prisma: any, ticketNumber: string) {
  const ticket = await prisma.supportTicket.findUnique({
    where: { ticketNumber },
    include: {
      user: {
        select: {
          id: true,
          fullName: true,
          email: true,
          role: true,
          createdAt: true,
          organization: { select: { id: true, name: true } },
        },
      },
      comments: {
        include: {
          user: { select: { id: true, fullName: true, email: true, role: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!ticket) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Ticket not found' });
  }

  return ticket;
}

export async function adminUpdateStatus(
  prisma: any,
  ticketId: string,
  newStatus: TicketStatus,
  adminUserId: string
) {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    include: { user: { select: { id: true, email: true, fullName: true } } },
  });

  if (!ticket) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Ticket not found' });
  }

  const oldStatus = ticket.status;
  const isClosed = newStatus === 'RESOLVED' || newStatus === 'CLOSED';

  const updated = await prisma.supportTicket.update({
    where: { id: ticketId },
    data: {
      status: newStatus,
      ...(isClosed && { closedAt: new Date() }),
    },
  });

  logger.info({
    type: 'ticket_status_updated',
    ticketNumber: ticket.ticketNumber,
    oldStatus,
    newStatus,
    adminUserId,
  });

  // In-app notification for ticket owner
  notificationModule.createNotification({
    userId: ticket.userId,
    type: 'TICKET_STATUS_UPDATE',
    title: `Ticket ${ticket.ticketNumber} Updated`,
    message: `Your ticket status changed from ${oldStatus} to ${newStatus}.`,
    link: `/support/${ticket.ticketNumber}`,
    metadata: { ticketNumber: ticket.ticketNumber, oldStatus, newStatus },
  }).catch((err: Error) => {
    logger.warn({ type: 'ticket_status_notification_failed', error: err.message });
  });

  // Email notification
  reactMailer.sendTicketStatusUpdateEmail(ticket.user.email, {
    ticketNumber: ticket.ticketNumber,
    subject: ticket.subject,
    userName: ticket.user.fullName,
    oldStatus,
    newStatus,
  }).catch((err: Error) => {
    logger.warn({ type: 'ticket_status_email_failed', error: err.message });
  });

  return updated;
}

export async function adminAddResponse(
  prisma: any,
  ticketId: string,
  adminUserId: string,
  message: string,
  updateStatusTo?: TicketStatus
) {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    include: { user: { select: { id: true, email: true, fullName: true } } },
  });

  if (!ticket) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Ticket not found' });
  }

  const admin = await prisma.user.findUnique({
    where: { id: adminUserId },
    select: { fullName: true },
  });

  const targetStatus: TicketStatus = updateStatusTo ?? 'AWAITING_USER';

  const [comment] = await Promise.all([
    prisma.ticketComment.create({
      data: { ticketId, userId: adminUserId, message, isAdmin: true },
      include: { user: { select: { id: true, fullName: true, email: true, role: true } } },
    }),
    prisma.supportTicket.update({
      where: { id: ticketId },
      data: { status: targetStatus },
    }),
  ]);

  // In-app notification
  notificationModule.createNotification({
    userId: ticket.userId,
    type: 'TICKET_RESPONSE',
    title: `New Response on ${ticket.ticketNumber}`,
    message: message.length > 100 ? `${message.slice(0, 100)}...` : message,
    link: `/support/${ticket.ticketNumber}`,
    metadata: { ticketNumber: ticket.ticketNumber },
  }).catch((err: Error) => {
    logger.warn({ type: 'ticket_response_notification_failed', error: err.message });
  });

  // Email notification
  reactMailer.sendTicketResponseEmail(ticket.user.email, {
    ticketNumber: ticket.ticketNumber,
    subject: ticket.subject,
    userName: ticket.user.fullName,
    responseMessage: message,
    responderName: admin?.fullName ?? 'SheriaBot Support',
  }).catch((err: Error) => {
    logger.warn({ type: 'ticket_response_email_failed', error: err.message });
  });

  return comment;
}

export async function getTicketStats(prisma: any) {
  const [open, inProgress, awaitingUser, resolved, closed, urgent] = await Promise.all([
    prisma.supportTicket.count({ where: { status: 'OPEN' } }),
    prisma.supportTicket.count({ where: { status: 'IN_PROGRESS' } }),
    prisma.supportTicket.count({ where: { status: 'AWAITING_USER' } }),
    prisma.supportTicket.count({ where: { status: 'RESOLVED' } }),
    prisma.supportTicket.count({ where: { status: 'CLOSED' } }),
    prisma.supportTicket.count({ where: { priority: 'URGENT', status: { notIn: ['RESOLVED', 'CLOSED'] } } }),
  ]);

  return { open, inProgress, awaitingUser, resolved, closed, urgent };
}
