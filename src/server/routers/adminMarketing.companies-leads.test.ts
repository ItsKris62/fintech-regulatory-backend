import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('adminMarketing.companies and adminMarketing.leads Router Architecture (P0)', () => {
  const routerPath = join(__dirname, 'adminMarketing.router.ts');
  const routerSrc = readFileSync(routerPath, 'utf8');

  it('exposes companies sub-router with all required CRUD and merge procedures under adminProcedure', () => {
    expect(routerSrc).toContain('companies:   companiesRouter,');
    expect(routerSrc).toContain('list: adminProcedure');
    expect(routerSrc).toContain('getById: adminProcedure');
    expect(routerSrc).toContain('create: adminProcedure');
    expect(routerSrc).toContain('update: adminProcedure');
    expect(routerSrc).toContain('delete: adminProcedure');
    expect(routerSrc).toContain('merge: adminProcedure');
  });

  it('exposes leads review queue sub-router with human-in-the-loop decisions under adminProcedure', () => {
    expect(routerSrc).toContain('leads:       leadsRouter,');
    expect(routerSrc).toContain('listReviewQueue: adminProcedure');
    expect(routerSrc).toContain('getReviewDetail: adminProcedure');
    expect(routerSrc).toContain('approveLead: adminProcedure');
    expect(routerSrc).toContain('rejectLead: adminProcedure');
    expect(routerSrc).toContain('nurtureLead: adminProcedure');
    expect(routerSrc).toContain('requestResearch: adminProcedure');
    expect(routerSrc).toContain('doNotContact: adminProcedure');
  });

  it('enforces Contact-optional approval flow (Amendment 14)', () => {
    expect(routerSrc).toContain('company.contacts.length > 0');
    expect(routerSrc).toContain('LeadStatus.APPROVED');
  });

  it('enforces Company-level DO_NOT_CONTACT without touching email suppression list (Amendment 7)', () => {
    expect(routerSrc).toContain('LeadStatus.DO_NOT_CONTACT');
    expect(routerSrc).toContain('MARKETING_COMPANY_DO_NOT_CONTACT');
  });
});
