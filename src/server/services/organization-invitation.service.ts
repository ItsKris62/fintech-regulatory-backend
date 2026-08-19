import { createHash, randomBytes } from 'crypto';
import { TRPCError } from '@trpc/server';
import { MemberStatus, SubscriptionPlan } from '@prisma/client';
import type { MemberRole } from '@prisma/client';
import { PLAN_ENTITLEMENTS } from '@/config/entitlements.config';
import { appConfig } from '@/config/app.config';
import { reactMailer } from '@/lib/email/react-mailer.service';
import { logger } from '@/utils/logger';
import { buildSeatLimitMessage, getSeatUsageForOrganization, hasSeatCapacity } from './organization-seat.service';

type TxLike = {
  $executeRaw: (query: TemplateStringsArray, ...values: any[]) => Promise<any>;
  organization: { findUnique: (args: any) => Promise<any> };
  organizationMember: {
    findUnique: (args: any) => Promise<any>;
    findFirst: (args: any) => Promise<any>;
    upsert: (args: any) => Promise<any>;
    count: (args: any) => Promise<number>;
  };
  invitation: {
    create: (args: any) => Promise<any>;
    findFirst: (args: any) => Promise<any>;
    findUnique: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
    count: (args: any) => Promise<number>;
  };
  user: {
    findUnique: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
  };
  auditLog?: { create: (args: any) => Promise<any> };
  pilotAccess?: { findFirst: (args: any) => Promise<any> };
};

export type OrganizationInvitationRole = MemberRole;

const SEAT_LOCK_NAMESPACE = 0x51ea; // stable namespace for org seat allocation locks

function signedIntFromHash(input: string): number {
  const hex = createHash('sha256').update(input).digest('hex').slice(0, 8);
  const unsigned = Number.parseInt(hex, 16);
  return unsigned > 0x7fffffff ? unsigned - 0x100000000 : unsigned;
}

export function generateInvitationToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashInvitationToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export async function lockOrganizationSeatAllocation(tx: TxLike, organizationId: string): Promise<void> {
  const lockKey = signedIntFromHash(organizationId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SEAT_LOCK_NAMESPACE}, ${lockKey})`;
}

export function invitationTokenWhere(rawToken: string): Array<{ token: string }> {
  const digest = hashInvitationToken(rawToken);
  return digest === rawToken ? [{ token: digest }] : [{ token: digest }, { token: rawToken }];
}

export function platformRoleForOrganizationPlan(plan: SubscriptionPlan): 'STARTUP' | 'ENTERPRISE' {
  return plan === SubscriptionPlan.ENTERPRISE ? 'ENTERPRISE' : 'STARTUP';
}

export async function assertOrganizationHasTeamSeats(tx: TxLike, organizationId: string): Promise<{ plan: SubscriptionPlan }> {
  const organization = await tx.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, plan: true, deletedAt: true } as any,
  });

  if (!organization || organization.deletedAt) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied to this organization' });
  }

  const plan = organization.plan as SubscriptionPlan;
  const entitlements = PLAN_ENTITLEMENTS[plan];
  if (!entitlements?.teamCollaboration) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Team member management requires the Business plan or higher.',
    });
  }

  return { plan };
}

export async function assertSeatCapacityLocked(tx: TxLike, organizationId: string): Promise<void> {
  const usage = await getSeatUsageForOrganization(tx as any, organizationId);
  if (!hasSeatCapacity(usage)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: buildSeatLimitMessage(usage) });
  }
}

export async function findValidInvitationByEmailAndToken(
  tx: TxLike,
  email: string,
  rawToken: string | undefined,
): Promise<any | null> {
  if (!rawToken) return null;

  return tx.invitation.findFirst({
    where: {
      email: email.toLowerCase(),
      used: false,
      revokedAt: null,
      expiresAt: { gt: new Date() },
      OR: invitationTokenWhere(rawToken),
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function hasPendingInvitationForEmail(tx: TxLike, email: string): Promise<boolean> {
  const invitation = await tx.invitation.findFirst({
    where: {
      email: email.toLowerCase(),
      used: false,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  });
  return Boolean(invitation);
}

export async function createOrganizationInvitationLocked(args: {
  tx: TxLike;
  actorUserId: string;
  organizationId: string;
  email: string;
  organizationRole: OrganizationInvitationRole;
  expiresInDays: number;
  inviterName?: string | null;
}): Promise<{ invitation: any; rawToken: string }> {
  const { tx, actorUserId, organizationId, email, organizationRole, expiresInDays } = args;
  const normalizedEmail = email.toLowerCase();

  await lockOrganizationSeatAllocation(tx, organizationId);
  const { plan } = await assertOrganizationHasTeamSeats(tx, organizationId);

  const [existingMember, existingInvite] = await Promise.all([
    tx.organizationMember.findFirst({
      where: {
        organizationId,
        user: { email: normalizedEmail },
        status: { in: [MemberStatus.ACTIVE, MemberStatus.SUSPENDED] },
      },
      select: { id: true },
    }),
    tx.invitation.findFirst({
      where: {
        organizationId,
        email: normalizedEmail,
        used: false,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    }),
  ]);

  if (existingMember) {
    throw new TRPCError({ code: 'CONFLICT', message: 'This email is already an active member of the organization' });
  }

  if (existingInvite) {
    throw new TRPCError({ code: 'CONFLICT', message: 'A pending invite already exists for this email' });
  }

  await assertSeatCapacityLocked(tx, organizationId);

  const rawToken = generateInvitationToken();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiresInDays);

  const invitation = await tx.invitation.create({
    data: {
      email: normalizedEmail,
      role: platformRoleForOrganizationPlan(plan),
      organizationRole,
      token: hashInvitationToken(rawToken),
      expiresAt,
      invitedBy: actorUserId,
      organizationId,
    },
  });

  return { invitation, rawToken };
}

export async function sendOrganizationInvitationEmail(args: {
  email: string;
  rawToken: string;
  role: string;
  inviterName?: string | null;
  expiresInDays: number;
}): Promise<void> {
  const inviteUrl = `${appConfig.frontendUrl}/register?token=${args.rawToken}&email=${encodeURIComponent(args.email)}`;
  await reactMailer.sendInvitationEmail(args.email, {
    inviterName: args.inviterName || 'SheriaBot',
    role: args.role,
    inviteUrl,
    expiresInDays: args.expiresInDays,
  });
}

export async function writeSafeAuditLog(tx: TxLike, args: {
  userId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  if (!tx.auditLog) return;
  await tx.auditLog.create({
    data: {
      userId: args.userId,
      action: args.action,
      entityType: args.entityType,
      entityId: args.entityId ?? undefined,
      metadata: args.metadata ?? {},
      ipAddress: args.ipAddress ?? undefined,
      userAgent: args.userAgent?.substring(0, 500),
    },
  }).catch((error: any) => {
    logger.warn({ type: 'audit_log_write_failed', action: args.action, error: error.message });
  });
}
