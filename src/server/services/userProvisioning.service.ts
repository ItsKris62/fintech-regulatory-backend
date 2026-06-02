import { MemberRole, MemberStatus, Prisma, SubscriptionPlan, SubscriptionStatus, UserRole } from '@prisma/client';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { BadRequestError, OrganizationNotFoundError } from '@/utils/error';
import { isPrismaForeignKeyError, sanitizeErrorMessage } from '@/utils/error-sanitizer';
import { logger } from '@/utils/logger';

const PILOT_DURATION_DAYS = 14;
const DEFAULT_PILOT_COHORT = 'PILOT_COHORT_ADMIN';

const userRoleSchema = z.enum(['REGULATOR', 'STARTUP', 'ENTERPRISE', 'ADMIN']);
const subscriptionTierSchema = z.enum(['REGULATOR', 'STARTUP', 'BUSINESS', 'ENTERPRISE']);

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cuidPattern = /^c[a-z0-9]{24}$/i;

export function isValidOrganizationId(value: string): boolean {
  return uuidPattern.test(value) || cuidPattern.test(value);
}

export const optionalOrganizationIdSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().refine(isValidOrganizationId, {
    message: 'Organization ID must be a valid organization identifier.',
  }).optional(),
);

export const createUserWithOrganizationInputSchema = z.object({
  email: z.string().trim().email(),
  fullName: z.string().trim().min(2).max(100),
  role: userRoleSchema.default('STARTUP'),
  subscriptionTier: subscriptionTierSchema.optional(),
  isPilot: z.boolean().default(false),
  organizationId: optionalOrganizationIdSchema,
  organizationName: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(2).max(120).optional(),
  ),
  supabaseAuthId: z.string().trim().min(1),
  adminId: z.string().trim().min(1),
  requestId: z.string().trim().min(1),
});

export type CreateUserWithOrganizationInput = z.infer<typeof createUserWithOrganizationInputSchema>;

const provisionedUserInclude = {
  organization: { select: { id: true, name: true, subscriptionTier: true, plan: true } },
} satisfies Prisma.UserInclude;

export type ProvisionedUser = Prisma.UserGetPayload<{ include: typeof provisionedUserInclude }>;
export type ProvisionedOrganization = NonNullable<ProvisionedUser['organization']>;

const createUserWithOrganizationOutputSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string().email(),
    organizationId: z.string().nullable(),
    isPilot: z.boolean(),
  }),
  organization: z.object({
    id: z.string(),
    name: z.string(),
  }).nullable(),
});

export interface CreateUserWithOrganizationResult {
  user: ProvisionedUser;
  organization: ProvisionedOrganization | null;
}

type ProvisioningTransaction = Pick<typeof prisma, 'organization' | 'user' | 'auditLog' | 'pilotEvent' | 'organizationMember'>;

function getSubscriptionTier(input: CreateUserWithOrganizationInput): 'REGULATOR' | 'STARTUP' | 'BUSINESS' | 'ENTERPRISE' {
  if (input.subscriptionTier) {
    return input.subscriptionTier;
  }

  return input.isPilot ? 'ENTERPRISE' : 'REGULATOR';
}

function getPilotExpiresAt(now: Date): Date {
  return new Date(now.getTime() + PILOT_DURATION_DAYS * 24 * 60 * 60 * 1000);
}

async function resolveOrganization(
  tx: ProvisioningTransaction,
  input: CreateUserWithOrganizationInput,
): Promise<ProvisionedOrganization | null> {
  if (input.organizationId) {
    const organization = await tx.organization.findUnique({
      where: { id: input.organizationId },
      select: { id: true, name: true, subscriptionTier: true, plan: true },
    });

    if (!organization) {
      throw new OrganizationNotFoundError(input.organizationId);
    }

    return organization;
  }

  if (!input.isPilot) {
    return null;
  }

  if (!input.organizationName) {
    throw new BadRequestError('Pilot users require an organization name or an existing organization.');
  }

  const subscriptionTier = getSubscriptionTier(input);

  return tx.organization.create({
    data: {
      name: input.organizationName,
      type: 'enterprise',
      organizationType: 'enterprise',
      subscriptionTier,
      subscriptionStatus: SubscriptionStatus.ACTIVE,
      plan: SubscriptionPlan.REGULATOR,
      verificationStatus: 'verified',
      verifiedAt: new Date(),
    },
    select: { id: true, name: true, subscriptionTier: true, plan: true },
  });
}

async function ensureEmailIsAvailable(tx: ProvisioningTransaction, email: string): Promise<void> {
  const existing = await tx.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (existing) {
    throw new BadRequestError('A user with this email already exists');
  }
}

export async function createUserWithOrganization(
  rawInput: CreateUserWithOrganizationInput,
): Promise<CreateUserWithOrganizationResult> {
  const input = createUserWithOrganizationInputSchema.parse(rawInput);
  const normalizedEmail = input.email.toLowerCase();

  try {
    const result = await prisma.$transaction(async (tx) => {
      await ensureEmailIsAvailable(tx, normalizedEmail);
      const organization = await resolveOrganization(tx, input);
      const now = new Date();

      const user = await tx.user.create({
        data: {
          supabaseAuthId: input.supabaseAuthId,
          email: normalizedEmail,
          fullName: input.fullName,
          role: input.role as UserRole,
          emailVerified: true,
          accountStatus: 'active',
          status: 'ACTIVE',
          organizationId: organization?.id ?? null,
          isPilot: input.isPilot,
          ...(input.isPilot
            ? {
                pilotCohort: DEFAULT_PILOT_COHORT,
                pilotStartedAt: now,
                pilotExpiresAt: getPilotExpiresAt(now),
                postPilotTier: 'REGULATOR',
              }
            : {}),
        },
        include: provisionedUserInclude,
      });

      // -----------------------------------------------------------------------
      // CRITICAL: Create OrganizationMember row so requireOrgMembership passes.
      // Without this row every orgMemberProcedure call returns FORBIDDEN/no_membership.
      // -----------------------------------------------------------------------
      if (organization) {
        await tx.organizationMember.upsert({
          where: {
            userId_organizationId: { userId: user.id, organizationId: organization.id },
          },
          create: {
            userId: user.id,
            organizationId: organization.id,
            role: MemberRole.OWNER,
            status: MemberStatus.ACTIVE,
            invitedBy: input.adminId,
          },
          update: {
            status: MemberStatus.ACTIVE,
            role: MemberRole.OWNER,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          userId: input.adminId,
          action: 'admin_create_user',
          entityType: 'User',
          entityId: user.id,
          metadata: {
            email: user.email,
            role: user.role,
            organizationId: user.organizationId,
            isPilot: user.isPilot,
          },
        },
      });

      if (input.isPilot) {
        await tx.pilotEvent.create({
          data: {
            id: nanoid(21),
            userId: user.id,
            action: 'PILOT_USER_PROVISIONED',
            feature: 'admin',
            metadata: {
              adminId: input.adminId,
              organizationId: organization?.id ?? null,
              organizationName: organization?.name ?? input.organizationName ?? null,
            },
          },
        });
      }

      return { user, organization: user.organization };
    });

    // Invalidate Redis membership cache so the new row is visible immediately.
    if (result.organization) {
      await redis
        .del(`sheriabot:orgmem:${result.user.id}:${result.organization.id}`)
        .catch(() => {});
    }

    createUserWithOrganizationOutputSchema.parse({
      user: result.user,
      organization: result.organization,
    });

    logger.info({
      type: 'user_provisioning',
      requestId: input.requestId,
      adminId: input.adminId,
      userId: result.user.id,
      organizationId: result.organization?.id ?? null,
      isPilot: result.user.isPilot,
    });

    return result;
  } catch (error: unknown) {
    logger.error({
      type: 'user_provisioning',
      requestId: input.requestId,
      adminId: input.adminId,
      email: normalizedEmail,
      error: sanitizeErrorMessage(error, 'User provisioning failed'),
    });

    if (isPrismaForeignKeyError(error)) {
      throw new OrganizationNotFoundError(input.organizationId);
    }

    throw error;
  }
}
