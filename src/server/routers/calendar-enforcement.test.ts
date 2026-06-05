import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SubscriptionPlan } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  EVENT_CATEGORIES,
  createComplianceEventSchema,
  updateComplianceEventSchema,
} from '../schemas/calendar.schema';
import {
  PLAN_ENTITLEMENTS,
  PILOT_ENTITLEMENT_PROFILES,
} from '@/config/entitlements.config';
import { hasFeature } from '@/utils/entitlements';

function repo(relativePath: string): string {
  return readFileSync(resolve(__dirname, '../../../..', relativePath), 'utf8');
}

function local(relativePath: string): string {
  return readFileSync(resolve(__dirname, relativePath), 'utf8');
}

describe('calendar router entitlement and RBAC map', () => {
  const calendarRouter = local('calendar.router.ts');
  const calendarModule = repo('fintech-regulatory-backend/src/modules/calendar/calendar.module.ts');
  const startupCalendarPage = repo('fintech-regulatory-platform/app/(dashboard)/startup/calendar/page.tsx');
  const addEventModal = repo('fintech-regulatory-platform/components/calendar/AddEventModal.tsx');
  const calendarConfig = repo('fintech-regulatory-platform/lib/calendar-config.ts');

  it('keeps all calendar procedures behind effective plan complianceCalendar gating', () => {
    const procedures = ['create', 'list', 'get', 'update', 'delete', 'upcoming'];

    for (const procedure of procedures) {
      const start = calendarRouter.indexOf(`${procedure}: orgMemberProcedure`);
      const body = calendarRouter.slice(start, start + 900);

      expect(start).toBeGreaterThan(-1);
      expect(body).toContain('use(withPlanContext)');
      expect(body).toContain("use(requirePlanFeature('complianceCalendar'))");
    }
  });

  it('requires organization owner/admin role for create and delete mutations', () => {
    for (const procedure of ['create', 'delete']) {
      const start = calendarRouter.indexOf(`${procedure}: orgMemberProcedure`);
      const body = calendarRouter.slice(start, start + 1200);

      expect(body).toContain('requireOrgMembershipRole([MemberRole.ADMIN, MemberRole.OWNER])');
    }
  });

  it('passes actor membership context into update so the module can enforce assigned-member completion only', () => {
    const start = calendarRouter.indexOf('update: orgMemberProcedure');
    const body = calendarRouter.slice(start, start + 1600);

    expect(body).toContain('actorUserId:    ctx.user!.id');
    expect(body).toContain('actorRole:      ctx.orgMembership!.role');
    expect(calendarModule).toContain('isAssignedCompletionUpdate');
    expect(calendarModule).toContain('existing.assigneeId !== actorUserId');
    expect(calendarModule).toContain('Only organization owners and admins can manage compliance calendar events.');
  });

  it('preserves tier behavior for calendar access', () => {
    expect(PLAN_ENTITLEMENTS.STARTUP.complianceCalendar).toBe(false);
    expect(hasFeature(SubscriptionPlan.STARTUP, 'complianceCalendar')).toBe(false);
    expect(hasFeature(SubscriptionPlan.BUSINESS, 'complianceCalendar')).toBe(true);
    expect(hasFeature(SubscriptionPlan.ENTERPRISE, 'complianceCalendar')).toBe(true);
    expect(PILOT_ENTITLEMENT_PROFILES.PILOT_FULL.complianceCalendar).toBe(true);
  });

  it('validates license timeline friendly categories without a destructive Prisma enum migration', () => {
    expect(EVENT_CATEGORIES).toEqual(expect.arrayContaining([
      'RENEWAL',
      'REGULATORY_DEADLINE',
      'AUDIT',
      'REVIEW',
      'DOCUMENT_EXPIRY',
      'COMPLIANCE_TASK',
      'CUSTOM',
    ]));

    expect(createComplianceEventSchema.safeParse({
      title: 'License renewal',
      dueDate: '2026-07-15T00:00:00.000Z',
      priority: 'HIGH',
      category: 'REGULATORY_DEADLINE',
      recurrence: 'NONE',
    }).success).toBe(true);

    expect(updateComplianceEventSchema.safeParse({
      id: 'cm00000000000000000000000',
      category: 'DOCUMENT_EXPIRY',
    }).success).toBe(true);
  });

  it('keeps frontend calendar gate and category display aligned', () => {
    expect(startupCalendarPage).toContain('FeatureGate');
    expect(startupCalendarPage).toContain('feature="complianceCalendar"');
    expect(startupCalendarPage).toContain('Available on the Business plan and above');
    expect(addEventModal).toContain('REGULATORY_DEADLINE');
    expect(addEventModal).toContain('DOCUMENT_EXPIRY');
    expect(addEventModal).toContain('COMPLIANCE_TASK');
    expect(calendarConfig).toContain('Regulatory Deadline');
    expect(calendarConfig).toContain('Document Expiry');
    expect(calendarConfig).toContain('Compliance Task');
  });
});
