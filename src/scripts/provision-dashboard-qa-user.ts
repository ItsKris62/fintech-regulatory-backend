import 'dotenv/config';
import { randomUUID } from 'crypto';
import { MemberRole, MemberStatus, SubscriptionPlan, SubscriptionStatus, UserRole, UserStatus } from '@prisma/client';
import { supabaseAdmin } from '@/lib/supabase';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { createUserWithOrganization } from '@/server/services/userProvisioning.service';

type EnvironmentClassification = 'development' | 'staging' | 'production' | 'unknown';
type ProvisionMode = 'primary' | 'limited';

const QA_USER_NAME = 'SheriaBot QA Startup';
const QA_ORGANIZATION_NAME = 'SheriaBot QA Sandbox';
const QA_LIMITED_ORGANIZATION_NAME = 'SheriaBot QA Limited Sandbox';
const QA_COHORT = 'QA_DASHBOARD_PHASE_2';
const QA_METADATA_SOURCE = 'dashboard_phase_2_qa_provisioning';
const PILOT_DAYS = 14;

interface QaAccountInput {
  email: string;
  password: string;
  mode: ProvisionMode;
}

interface QaAccountResult {
  mode: ProvisionMode;
  createdAuthUser: boolean;
  createdSheriaBotUser: boolean;
  supabaseLinked: boolean;
  emailConfirmed: boolean;
  role: UserRole;
  organizationMembership: MemberStatus | null;
  entitlement: 'PILOT_FULL' | 'STARTUP_PLAN';
}

function firstOrigin(value: string | undefined): string {
  return (value ?? '').split(',')[0]?.trim() ?? '';
}

function hostname(value: string | undefined): string {
  try {
    return new URL(firstOrigin(value)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function classifyEnvironment(): EnvironmentClassification {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const dbEnv = process.env.DATABASE_ENVIRONMENT ?? 'unknown';
  const runtimeMode = process.env.APP_RUNTIME_MODE ?? 'standard';
  const appHost = hostname(process.env.APP_URL);
  const frontendHost = hostname(process.env.FRONTEND_URL);

  const productionSignals = [
    nodeEnv === 'production',
    dbEnv === 'production',
    appHost === 'sheriabot.com' || appHost === 'app.sheriabot.com' || appHost === 'api.sheriabot.com',
    frontendHost === 'sheriabot.com' || frontendHost === 'app.sheriabot.com',
  ];

  if (productionSignals.some(Boolean)) return 'production';
  if (dbEnv === 'preview' || runtimeMode === 'preview') return 'staging';
  if (
    nodeEnv === 'development' ||
    nodeEnv === 'test' ||
    dbEnv === 'development-uat' ||
    appHost === 'localhost' ||
    appHost === '127.0.0.1' ||
    frontendHost === 'localhost' ||
    frontendHost === '127.0.0.1'
  ) {
    return 'development';
  }

  return 'unknown';
}

function assertSafeToRun(): EnvironmentClassification {
  const classification = classifyEnvironment();

  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing QA provisioning while NODE_ENV=production.');
  }

  if (classification === 'production') {
    throw new Error('Refusing QA provisioning against a production-classified Supabase environment.');
  }

  if (classification === 'unknown') {
    throw new Error('Refusing QA provisioning because the Supabase environment classification is unknown.');
  }

  if (process.env.ALLOW_QA_USER_PROVISIONING !== 'true') {
    throw new Error('Set ALLOW_QA_USER_PROVISIONING=true to run disposable QA account provisioning.');
  }

  return classification;
}

function requireSecret(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function validatePasswordShape(password: string): void {
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);

  if (password.length < 20 || !hasUpper || !hasLower || !hasDigit || !hasSymbol) {
    throw new Error('QA password does not satisfy the required temporary password shape.');
  }
}

async function findProvisioningAdminId(): Promise<string> {
  const admin = await prisma.user.findFirst({
    where: {
      role: UserRole.ADMIN,
      accountStatus: 'active',
      deletedAt: null,
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });

  if (!admin) {
    throw new Error('No active SheriaBot admin user exists for audited QA provisioning.');
  }

  return admin.id;
}

async function findAuthUserByEmail(email: string): Promise<{ id: string; emailConfirmedAt: string | null } | null> {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw error;

    const found = data.users.find((user) => user.email?.toLowerCase() === email);
    if (found) {
      return {
        id: found.id,
        emailConfirmedAt: found.email_confirmed_at ?? null,
      };
    }

    if (data.users.length < 100) break;
  }

  return null;
}

async function ensureAuthUser(input: QaAccountInput): Promise<{ id: string; created: boolean; emailConfirmed: boolean }> {
  const existing = await findAuthUserByEmail(input.email);

  if (existing) {
    const { data, error } = await supabaseAdmin.auth.admin.updateUserById(existing.id, {
      password: input.password,
      email_confirm: true,
      user_metadata: {
        role: 'STARTUP',
        fullName: QA_USER_NAME,
        qaPurpose: 'dashboard_phase_2',
      },
    });

    if (error || !data.user) {
      throw new Error(error?.message ?? 'Failed to update existing Supabase Auth QA user.');
    }

    return {
      id: data.user.id,
      created: false,
      emailConfirmed: Boolean(data.user.email_confirmed_at ?? existing.emailConfirmedAt),
    };
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    user_metadata: {
      role: 'STARTUP',
      fullName: QA_USER_NAME,
      qaPurpose: 'dashboard_phase_2',
    },
  });

  if (error || !data.user) {
    throw new Error(error?.message ?? 'Failed to create Supabase Auth QA user.');
  }

  return {
    id: data.user.id,
    created: true,
    emailConfirmed: Boolean(data.user.email_confirmed_at),
  };
}

async function ensurePilotAccess(userId: string, organizationId: string, adminId: string): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PILOT_DAYS * 24 * 60 * 60 * 1000);

  await (prisma as any).pilotAccess.updateMany({
    where: { userId, organizationId, status: 'ACTIVE' },
    data: {
      entitlementProfile: 'PILOT_FULL',
      expiresAt,
      metadata: {
        source: QA_METADATA_SOURCE,
        cohort: QA_COHORT,
      },
    },
  });

  const activeAccess = await (prisma as any).pilotAccess.findFirst({
    where: { userId, organizationId, status: 'ACTIVE' },
    select: { id: true },
  });

  if (!activeAccess) {
    await (prisma as any).pilotAccess.create({
      data: {
        userId,
        organizationId,
        status: 'ACTIVE',
        entitlementProfile: 'PILOT_FULL',
        startsAt: now,
        expiresAt,
        extensionCount: 0,
        createdByAdminId: adminId,
        metadata: {
          source: QA_METADATA_SOURCE,
          cohort: QA_COHORT,
        },
      },
    });
  }
}

async function normalizeQaUser(
  input: QaAccountInput,
  authUserId: string,
  adminId: string,
): Promise<{ createdUser: boolean; userId: string; organizationId: string; membershipStatus: MemberStatus }> {
  const existingUser = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true, organizationId: true },
  });

  let userId = existingUser?.id;
  let organizationId = existingUser?.organizationId ?? null;
  let createdUser = false;

  if (!existingUser) {
    const result = await createUserWithOrganization({
      email: input.email,
      fullName: QA_USER_NAME,
      role: 'STARTUP',
      subscriptionTier: 'STARTUP',
      isPilot: true,
      organizationName: input.mode === 'primary' ? QA_ORGANIZATION_NAME : QA_LIMITED_ORGANIZATION_NAME,
      orgRole: 'OWNER',
      supabaseAuthId: authUserId,
      adminId,
      requestId: `qa-dashboard-${randomUUID()}`,
    });

    userId = result.user.id;
    organizationId = result.organization?.id ?? null;
    createdUser = true;
  }

  if (!userId) {
    throw new Error('Unable to resolve SheriaBot QA user.');
  }

  if (!organizationId) {
    const organization = await prisma.organization.create({
      data: {
        name: input.mode === 'primary' ? QA_ORGANIZATION_NAME : QA_LIMITED_ORGANIZATION_NAME,
        type: 'startup',
        organizationType: 'startup',
        subscriptionTier: input.mode === 'primary' ? 'STARTUP' : 'starter',
        subscriptionStatus: SubscriptionStatus.ACTIVE,
        plan: input.mode === 'primary' ? SubscriptionPlan.REGULATOR : SubscriptionPlan.STARTUP,
        verificationStatus: 'verified',
        verifiedAt: new Date(),
        maxSeats: 1,
      },
      select: { id: true },
    });
    organizationId = organization.id;
  }

  const now = new Date();

  await prisma.organization.update({
    where: { id: organizationId },
    data: {
      name: input.mode === 'primary' ? QA_ORGANIZATION_NAME : QA_LIMITED_ORGANIZATION_NAME,
      type: 'startup',
      organizationType: 'startup',
      subscriptionTier: input.mode === 'primary' ? 'STARTUP' : 'starter',
      subscriptionStatus: SubscriptionStatus.ACTIVE,
      plan: input.mode === 'primary' ? SubscriptionPlan.REGULATOR : SubscriptionPlan.STARTUP,
      verificationStatus: 'verified',
      verifiedAt: now,
      maxSeats: 1,
    },
  });

  await prisma.user.update({
    where: { id: userId },
    data: {
      supabaseAuthId: authUserId,
      fullName: QA_USER_NAME,
      role: UserRole.STARTUP,
      status: UserStatus.ACTIVE,
      accountStatus: 'active',
      emailVerified: true,
      emailVerifiedAt: now,
      organizationId,
      deletedAt: null,
      mustChangePassword: false,
      ...(input.mode === 'primary'
        ? {
            isPilot: true,
            pilotCohort: QA_COHORT,
            pilotStartedAt: now,
            pilotExpiresAt: new Date(now.getTime() + PILOT_DAYS * 24 * 60 * 60 * 1000),
            pilotAccessStatus: 'ACTIVE',
            pilotExtensionCount: 0,
            pilotCreatedByAdminId: adminId,
            postPilotTier: 'REGULATOR',
          }
        : {
            isPilot: false,
            pilotCohort: null,
            pilotStartedAt: null,
            pilotExpiresAt: null,
            pilotAccessStatus: 'REVOKED',
            pilotExtensionCount: 0,
            pilotCreatedByAdminId: null,
            postPilotTier: 'REGULATOR',
          }),
    } as any,
  });

  const membership = await prisma.organizationMember.upsert({
    where: {
      userId_organizationId: {
        userId,
        organizationId,
      },
    },
    create: {
      userId,
      organizationId,
      role: MemberRole.OWNER,
      status: MemberStatus.ACTIVE,
      invitedBy: adminId,
      invitedAt: now,
    },
    update: {
      role: MemberRole.OWNER,
      status: MemberStatus.ACTIVE,
    },
    select: { status: true },
  });

  if (input.mode === 'primary') {
    await ensurePilotAccess(userId, organizationId, adminId);
  } else {
    await (prisma as any).pilotAccess.deleteMany({ where: { userId, organizationId } });
  }

  await Promise.all([
    redis.del(`user:session:${authUserId}`).catch(() => {}),
    redis.del(`sheriabot:orgmem:${userId}:${organizationId}`).catch(() => {}),
    redis.del(`sheriabot:planctx:${userId}`).catch(() => {}),
  ]);

  return { createdUser, userId, organizationId, membershipStatus: membership.status };
}

async function provisionAccount(input: QaAccountInput, adminId: string): Promise<QaAccountResult> {
  const normalizedEmail = input.email.toLowerCase();
  validatePasswordShape(input.password);

  const authUser = await ensureAuthUser({ ...input, email: normalizedEmail });
  const linked = await normalizeQaUser({ ...input, email: normalizedEmail }, authUser.id, adminId);

  return {
    mode: input.mode,
    createdAuthUser: authUser.created,
    createdSheriaBotUser: linked.createdUser,
    supabaseLinked: true,
    emailConfirmed: authUser.emailConfirmed,
    role: UserRole.STARTUP,
    organizationMembership: linked.membershipStatus,
    entitlement: input.mode === 'primary' ? 'PILOT_FULL' : 'STARTUP_PLAN',
  };
}

async function cleanupAccount(email: string): Promise<void> {
  const normalizedEmail = email.toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, supabaseAuthId: true, organizationId: true, role: true },
  });

  const authUser = await findAuthUserByEmail(normalizedEmail);
  const authId = user?.supabaseAuthId ?? authUser?.id ?? null;

  if (authId) {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(authId);
    if (error && !error.message.toLowerCase().includes('not found')) {
      throw error;
    }
  }

  if (!user) return;

  if (user.role === UserRole.ADMIN) {
    throw new Error('Refusing to clean up an ADMIN user through the dashboard QA cleanup path.');
  }

  await prisma.session.deleteMany({ where: { userId: user.id } });
  await (prisma as any).pilotAccess.deleteMany({ where: { userId: user.id } });

  if (user.organizationId) {
    await prisma.organizationMember.deleteMany({
      where: { userId: user.id, organizationId: user.organizationId },
    });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      status: UserStatus.SUSPENDED,
      accountStatus: 'cancelled',
      email: `deleted_${user.id}@sheriabot.internal`,
      supabaseAuthId: null,
      deletedAt: new Date(),
    },
  });

  if (user.organizationId) {
    const relatedUsers = await prisma.user.count({
      where: { organizationId: user.organizationId, deletedAt: null },
    });
    const relatedMembers = await prisma.organizationMember.count({
      where: { organizationId: user.organizationId },
    });

    if (relatedUsers === 0 && relatedMembers === 0) {
      await prisma.complianceEvent.deleteMany({ where: { organizationId: user.organizationId } });
      await prisma.complianceItem.deleteMany({ where: { organizationId: user.organizationId } });
      await prisma.organization.delete({ where: { id: user.organizationId } }).catch(() => {});
    }

    await redis.del(`sheriabot:orgmem:${user.id}:${user.organizationId}`).catch(() => {});
  }

  await redis.del(`sheriabot:planctx:${user.id}`).catch(() => {});
}

async function cleanup(): Promise<void> {
  const emails = [
    process.env.QA_STARTUP_EMAIL,
    process.env.QA_LIMITED_PLAN_EMAIL,
  ].filter((value): value is string => Boolean(value?.trim()));

  for (const email of emails) {
    await cleanupAccount(email);
  }

  console.log('QA dashboard cleanup complete.');
}

async function main(): Promise<void> {
  const classification = assertSafeToRun();
  const isCleanup = process.argv.includes('--cleanup');

  if (isCleanup) {
    await cleanup();
    console.log(`Environment classification: ${classification}`);
    return;
  }

  const adminId = await findProvisioningAdminId();
  const primary = await provisionAccount({
    email: requireSecret('QA_STARTUP_EMAIL'),
    password: requireSecret('QA_STARTUP_PASSWORD'),
    mode: 'primary',
  }, adminId);

  const results = [primary];

  const limitedEmail = process.env.QA_LIMITED_PLAN_EMAIL?.trim();
  const limitedPassword = process.env.QA_LIMITED_PLAN_PASSWORD?.trim();

  if (limitedEmail && limitedPassword) {
    results.push(await provisionAccount({
      email: limitedEmail,
      password: limitedPassword,
      mode: 'limited',
    }, adminId));
  }

  console.log(`Environment classification: ${classification}`);
  for (const result of results) {
    console.log([
      `${result.mode} QA account provisioned`,
      `authUserCreated=${result.createdAuthUser ? 'yes' : 'no'}`,
      `sheriaBotUserCreated=${result.createdSheriaBotUser ? 'yes' : 'no'}`,
      `supabaseLinked=${result.supabaseLinked ? 'yes' : 'no'}`,
      `emailConfirmed=${result.emailConfirmed ? 'yes' : 'no'}`,
      `role=${result.role}`,
      `membership=${result.organizationMembership ?? 'none'}`,
      `entitlement=${result.entitlement}`,
    ].join(' '));
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'QA dashboard provisioning failed.');
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
