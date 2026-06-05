import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function src(relativePath: string): string {
  return readFileSync(resolve(__dirname, relativePath), 'utf8');
}

describe('Business and Startup organization limit enforcement map', () => {
  const organizationRouter = src('organization.router.ts');
  const billingRouter = src('billing.router.ts');
  const provisioningService = src('../services/userProvisioning.service.ts');
  const guardService = src('../services/organization-plan-limit.service.ts');

  it('centralizes the one-organization rule in a shared guard', () => {
    expect(guardService).toContain('assertCanCreateOrJoinOrganization');
    expect(guardService).toContain('SubscriptionPlan.STARTUP');
    expect(guardService).toContain('SubscriptionPlan.BUSINESS');
    expect(guardService).toContain('Enterprise');
    expect(guardService).toContain('MemberStatus.ACTIVE');
    expect(guardService).toContain('BUSINESS_ORG_LIMIT_MESSAGE');
  });

  it('guards the active organization creation route and creates authoritative owner membership', () => {
    const start = organizationRouter.indexOf('create: protectedProcedure');
    const body = organizationRouter.slice(start, start + 3600);

    expect(body).toContain('assertCanCreateOrJoinOrganization');
    expect(body).toContain("sourceProcedure: 'organization.create'");
    expect(body).toContain('ctx.prisma.$transaction');
    expect(body).toContain('tx.organizationMember.upsert');
    expect(body).toContain('role: MemberRole.OWNER');
    expect(body).toContain('status: MemberStatus.ACTIVE');
    expect(body).toContain('userCache.delete(ctx.user.id)');
  });

  it('guards active direct member attachment before the membership upsert', () => {
    const start = organizationRouter.indexOf('addMember: protectedProcedure');
    const body = organizationRouter.slice(start, start + 3600);
    const guardIndex = body.indexOf('assertCanCreateOrJoinOrganization');
    const upsertIndex = body.indexOf('ctx.prisma.organizationMember.upsert');

    expect(guardIndex).toBeGreaterThan(-1);
    expect(upsertIndex).toBeGreaterThan(guardIndex);
    expect(body).toContain("sourceProcedure: 'organization.addMember'");
  });

  it('guards Business checkout before attaching a subscription to the org billing context', () => {
    const start = billingRouter.indexOf('createCheckoutSession: orgMemberProcedure');
    const body = billingRouter.slice(start, start + 5200);
    const guardIndex = body.indexOf('assertCanCreateOrJoinOrganization');
    const stripeIndex = body.indexOf('stripe.checkout.sessions.create');

    expect(guardIndex).toBeGreaterThan(-1);
    expect(stripeIndex).toBeGreaterThan(guardIndex);
    expect(body).toContain("sourceProcedure: 'billing.createCheckoutSession'");
    expect(body).toContain('requestedPlan: input.plan as SubscriptionPlan');
  });

  it('keeps admin provisioning as an explicit Platform Super Admin override', () => {
    expect(provisioningService).toContain('assertCanCreateOrJoinOrganization');
    expect(provisioningService).toContain("sourceProcedure: 'userProvisioning.createUserWithOrganization'");
    expect(provisioningService).toContain('platformAdminOverride: true');
  });
});
