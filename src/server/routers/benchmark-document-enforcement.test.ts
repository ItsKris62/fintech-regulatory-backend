import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function repo(relativePath: string): string {
  return readFileSync(resolve(__dirname, '../../../..', relativePath), 'utf8');
}

function local(relativePath: string): string {
  return readFileSync(resolve(__dirname, relativePath), 'utf8');
}

describe('benchmark document enforcement and alignment map', () => {
  const documentRouter = local('document.router.ts');
  const gapAnalysisRouter = local('gap-analysis.router.ts');
  const benchmarkService = local('../services/benchmark-document.service.ts');
  const complianceModule = repo('fintech-regulatory-backend/src/modules/compliance/compliance.module.ts');
  const docxExportService = repo('fintech-regulatory-backend/src/services/gap-analysis-export.service.ts');
  const frontendGapAnalysisPage = repo('fintech-regulatory-platform/app/(dashboard)/startup/gap-analysis/page.tsx');
  const pdfHtmlBuilder = repo('fintech-regulatory-platform/lib/utils/buildGapAnalysisReportHtml.ts');

  it('exposes benchmark document listing behind both Gap Analysis and benchmark document entitlements', () => {
    const start = documentRouter.indexOf('listBenchmarkDocuments: orgMemberProcedure');
    const body = documentRouter.slice(start, start + 1800);

    expect(start).toBeGreaterThan(-1);
    expect(body).toContain('use(withPlanContext)');
    expect(body).toContain("use(requirePlanFeature('gapAnalysis'))");
    expect(body).toContain("use(requirePlanFeature('benchmarkDocuments'))");
    expect(body).toContain('listAuthorizedBenchmarkDocuments');
    expect(body).toContain('benchmark_documents_listed');
  });

  it('validates selected benchmark IDs with tenant-aware authorization before analysis starts', () => {
    const start = gapAnalysisRouter.indexOf('runGapAnalysis: orgMemberProcedure');
    const body = gapAnalysisRouter.slice(start, start + 8200);

    expect(body).toContain("use(requirePlanFeature('gapAnalysis'))");
    expect(body).toContain("use(requirePlanFeature('benchmarkDocuments'))");
    expect(body).toContain('validateAuthorizedBenchmarkDocumentIds');
    expect(body).toContain('organizationId: orgId');
    expect(body).not.toContain('Invalid benchmark document ID(s):');
  });

  it('keeps authorization in the DB query shape and avoids ID-specific failure messages', () => {
    expect(benchmarkService).toContain('buildAuthorizedLegalBenchmarkWhere');
    expect(benchmarkService).toContain('organizationId: input.organizationId');
    expect(benchmarkService).toContain('userId: input.userId');
    expect(benchmarkService).toContain('contentStatus: ContentStatus.PUBLISHED');
    expect(benchmarkService).toContain('DocumentStatus.INDEXED');
    expect(benchmarkService).toContain('One or more benchmark documents are unavailable');
    expect(benchmarkService).not.toContain('Invalid benchmark document ID(s):');
  });

  it('uses selected benchmark documents as a strict RAG filter with framework-only fallback', () => {
    expect(complianceModule).toContain('const frameworkSlug = regulatoryFrameworkSlugs[index]');
    expect(complianceModule).toContain('...(frameworkSlug ? { frameworkSlug } : {})');
    expect(complianceModule).toContain('documentId: pineconeInFilter(benchmarkDocumentIds)');
    expect(complianceModule).toContain('fallbackIfTooFew');
    expect(complianceModule).toContain('const relaxedFilter = frameworkSlug ? { frameworkSlug } : undefined');
  });

  it('aligns the frontend selector with the benchmark document endpoint and corpus wording', () => {
    expect(frontendGapAnalysisPage).toContain('trpc.document.listBenchmarkDocuments.useQuery');
    expect(frontendGapAnalysisPage).toContain('SheriaBot Legal Corpus');
    expect(frontendGapAnalysisPage).toContain('Organization Documents');
    expect(frontendGapAnalysisPage).toContain('Select the legal or regulatory documents SheriaBot should use as benchmarks');
    expect(frontendGapAnalysisPage).not.toContain('trpc.document.list.useQuery(\n    { page: 1, limit: 100 }');
  });

  it('carries selected benchmark document metadata into PDF and DOCX exports', () => {
    expect(docxExportService).toContain('Benchmark Documents');
    expect(docxExportService).toContain('selectedBenchmarkDocuments');
    expect(pdfHtmlBuilder).toContain('Benchmark Documents');
    expect(pdfHtmlBuilder).toContain('selectedBenchmarkDocuments');
  });
});
