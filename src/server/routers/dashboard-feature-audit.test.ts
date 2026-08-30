import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function repo(relativePath: string): string {
  return readFileSync(resolve(__dirname, '../../../..', relativePath), 'utf8');
}

function local(relativePath: string): string {
  return readFileSync(resolve(__dirname, relativePath), 'utf8');
}

describe('dashboard feature audit invariants', () => {
  const schema = repo('fintech-regulatory-backend/prisma/schema.prisma');
  const jurisdictionConfig = repo('fintech-regulatory-backend/src/config/jurisdictions.config.ts');
  const applicationSchema = repo('fintech-regulatory-backend/src/server/schemas/application.schema.ts');
  const applicationRouter = local('application.router.ts');
  const customFrameworkRouter = local('custom-framework.router.ts');
  const alertSchema = repo('fintech-regulatory-backend/src/modules/alert/alert.schema.ts');
  const alertService = repo('fintech-regulatory-backend/src/modules/alert/alert.service.ts');

  it('limits audited dashboard jurisdictions to the four activated countries', () => {
    expect(jurisdictionConfig).toContain("['KE', 'RW', 'MW', 'NG']");
  });

  it('persists and filters application jurisdictions without client-controlled ownership', () => {
    expect(schema).toContain('jurisdictionCode  String                         @default("KE")');
    expect(schema).toContain('currency      String                @default("KES")');
    expect(applicationSchema).toContain('jurisdictionCode: jurisdictionCodeSchema.default');
    expect(applicationSchema).toContain('currency: applicationCurrencySchema.default');
    expect(applicationRouter).toContain('organizationId: ctx.orgMembership!.organizationId');
    expect(applicationRouter).toContain('if (input.jurisdictionCode) where.jurisdictionCode = input.jurisdictionCode');
    expect(applicationRouter).toContain("code: 'FORBIDDEN'");
  });

  it('keeps custom frameworks enterprise-gated and jurisdiction constrained', () => {
    expect(customFrameworkRouter).toContain("requirePlanFeature('customFrameworks')");
    expect(customFrameworkRouter).toContain('jurisdiction: jurisdictionSchema.optional().nullable()');
    expect(customFrameworkRouter).toContain('uniqueFrameworkSlug');
    expect(customFrameworkRouter).toContain("code: 'FORBIDDEN'");
  });

  it('stores alert jurisdiction and routes subscriptions by country', () => {
    expect(schema).toContain('jurisdictionCode String  @default("KE")');
    expect(schema).toContain('jurisdictions     String[] @default(["KE"])');
    expect(alertSchema).toContain('ALERT_JURISDICTIONS');
    expect(alertSchema).toContain("'BNR'");
    expect(alertSchema).toContain("'RBM'");
    expect(alertService).toContain('jurisdictions: { has: publishedAlert.jurisdictionCode }');
    expect(alertService).toContain('...(jurisdictionCode ? { jurisdictionCode } : {})');
  });
});
