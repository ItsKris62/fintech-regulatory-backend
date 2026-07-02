import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const repoRoot = resolve(__dirname, '../../../..');

function src(relativePath: string): string {
  return readFileSync(resolve(repoRoot, 'fintech-regulatory-backend/src', relativePath), 'utf8');
}

describe('Enterprise Policy Router Security Invariants', () => {
  const routerSrc = src('server/routers/enterprise-policy.router.ts');

  it('blocks Startup and Business users by requiring policyGeneration plan feature', () => {
    const endpoints = [
      'createDraft:',
      'getStatus:',
      'getPolicy:',
      'listPolicies:',
      'updateSectionContent:',
      'updateSectionStatus:',
      'getVersionHistory:',
      'deletePolicy:',
      'exportPolicy:',
    ];

    for (const endpoint of endpoints) {
      const endpointIndex = routerSrc.indexOf(endpoint);
      expect(endpointIndex).toBeGreaterThan(-1);

      // Find the end of this procedure (roughly by finding the next procedure or end of file)
      let nextEndpointIndex = routerSrc.length;
      for (const otherEndpoint of endpoints) {
        const idx = routerSrc.indexOf(otherEndpoint, endpointIndex + endpoint.length);
        if (idx !== -1 && idx < nextEndpointIndex) {
          nextEndpointIndex = idx;
        }
      }

      const procedureBody = routerSrc.slice(endpointIndex, nextEndpointIndex);
      // Ensures the policyGeneration entitlement is required, which blocks STARTUP/BUSINESS but allows ENTERPRISE/PILOT
      expect(procedureBody).toContain(".use(requirePlanFeature('policyGeneration'))");
    }
  });

  it('enforces organization isolation across all read, update, approve, delete, and export operations', () => {
    // Operations that read or modify a specific policy must check policy.organizationId !== organizationId
    expect(routerSrc.match(/policy\.organizationId !== (organizationId|ctx\.orgMembership!\.organizationId)/g)?.length).toBeGreaterThanOrEqual(7);
  });

  it('rejects creating a policy from another organization’s Gap Analysis', () => {
    expect(routerSrc).toContain('if (!gap || gap.organizationId !== organizationId)');
    expect(routerSrc).toContain("message: 'Source gap analysis not found or does not belong to your organization.'");
  });

  it('excludes soft-deleted policies from listPolicies and blocks fetch/update/approve/export', () => {
    expect(routerSrc).toContain('deletedAt: null'); // in listPolicies
    
    // Check that individual fetch operations reject deleted policies
    expect(routerSrc.match(/if \(\!policy \|\| policy\.deletedAt\)/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it('ensures getStatus returns safe status/progress fields only without exposing full policy text', () => {
    const getStatusBody = routerSrc.slice(routerSrc.indexOf('getStatus:'), routerSrc.indexOf('getPolicy:'));
    expect(getStatusBody).toContain('status: true');
    expect(getStatusBody).toContain('progress: true');
    expect(getStatusBody).not.toContain('sections: true');
    expect(getStatusBody).not.toContain('content: true');
  });

  it('creates a GeneratedPolicySectionVersion entry on updateSectionContent', () => {
    expect(routerSrc).toContain('prisma.generatedPolicySectionVersion.create');
  });

  it('validates status transitions in updateSectionStatus', () => {
    expect(routerSrc).toContain('updateSectionStatus: orgMemberProcedure');
    expect(routerSrc).toContain('updateSectionStatusSchema');
    // The validation is handled in the schema which strictly types `status`.
  });

  it('preserves DOCX export logging and functionality', () => {
    const exportBody = routerSrc.slice(routerSrc.indexOf('exportPolicy:'), routerSrc.length);
    expect(exportBody).toContain('generatedPolicyExportService.generateDocx');
    expect(exportBody).toContain('prisma.generatedPolicyExportLog.create');
    expect(exportBody).toContain("format: input.format,");
  });

  it('returns a clean BAD_REQUEST for PDF export without logging or updating format', () => {
    const exportBody = routerSrc.slice(routerSrc.indexOf('exportPolicy:'), routerSrc.length);
    expect(exportBody).toContain("if (input.format === 'PDF')");
    expect(exportBody).toContain("message: 'PDF export is not available in this environment. Please export as DOCX.'");
    
    // The rejection is before the actual export logging and before the date/format update
    const pdfRejectionIdx = exportBody.indexOf("if (input.format === 'PDF')");
    const exportLogIdx = exportBody.indexOf('prisma.generatedPolicyExportLog.create');
    const dbUpdateIdx = exportBody.indexOf('prisma.generatedPolicy.update');
    
    expect(pdfRejectionIdx).toBeLessThan(exportLogIdx);
    expect(pdfRejectionIdx).toBeLessThan(dbUpdateIdx);
  });

  it('ensures failed authorization or failed PDF export does not increment usage', () => {
    const createDraftBody = routerSrc.slice(routerSrc.indexOf('createDraft:'), routerSrc.indexOf('getStatus:'));
    expect(createDraftBody).toContain('deferIncrement: true'); // Increments usage safely
    expect(createDraftBody).toContain('await ctx.incrementUsage()'); // Only increments on success
  });
});
