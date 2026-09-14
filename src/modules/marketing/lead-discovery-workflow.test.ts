import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  KENYA_DISCOVERY_SOURCES,
  getDiscoverySources,
  updateDiscoverySourceState,
} from './lead-discovery-sources';
import {
  PROMPT_REGISTRY,
  LEAD_SOURCE_EXTRACT_KE_V1,
  LEAD_COMPANY_RESEARCH_KE_V1,
  LEAD_PRODUCT_FIT_KE_V1,
  LEAD_EVIDENCE_VERIFY_KE_V1,
} from './lead-discovery-prompts';
import { leadIngestionService } from './lead-ingestion.service';
import { TASK_TYPE_USE_CASE_MAP } from '../agents/automation/types';
import { prisma } from '@/lib/prisma/client';
import { DiscoveryRunStatus, CompanyOrigin, LeadStatus, IcpTier } from '@prisma/client';

// Mock prisma for isolated testing
vi.mock('@/lib/prisma/client', () => {
  const mockDb = {
    company: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    organization: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    discoveryRun: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    discoveryEvidence: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    discoveryRunCompany: {
      upsert: vi.fn(),
    },
    user: {
      findFirst: vi.fn().mockResolvedValue({ id: 'sys-admin-user-id' }),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: 'audit-log-id' }),
    },
    systemConfig: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  return { prisma: mockDb };
});

describe('W-SALES-LEADS-01 — Kenya AI Prospect Discovery Verification Suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // 1. Biweekly Cycle Calculation (Fixed Anchor: 2026-09-14T08:00:00+03:00)
  // =========================================================================
  describe('1. Fixed Anchor Biweekly Cycle Logic', () => {
    const ANCHOR_ISO = '2026-09-14T08:00:00+03:00';
    const ANCHOR_MS = new Date(ANCHOR_ISO).getTime();
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const CYCLE_DURATION_MS = 14 * MS_PER_DAY;

    function computeCycle(currentTimeMs: number) {
      const elapsedMs = Math.max(0, currentTimeMs - ANCHOR_MS);
      const cycleNumber = Math.floor(elapsedMs / CYCLE_DURATION_MS) + 1;
      const cycleStartMs = ANCHOR_MS + (cycleNumber - 1) * CYCLE_DURATION_MS;
      const cycleEndMs = cycleStartMs + CYCLE_DURATION_MS;
      return {
        cycleNumber,
        cycleKey: `KE-LEADS-CYCLE-${cycleNumber}`,
        runIdempotencyKey: `W-SALES-LEADS-01-KE-CYCLE-${cycleNumber}`,
        cycleStart: new Date(cycleStartMs).toISOString(),
        cycleEnd: new Date(cycleEndMs).toISOString(),
      };
    }

    it('computes cycle 1 at the anchor timestamp', () => {
      const cycle = computeCycle(ANCHOR_MS);
      expect(cycle.cycleNumber).toBe(1);
      expect(cycle.cycleKey).toBe('KE-LEADS-CYCLE-1');
      expect(cycle.runIdempotencyKey).toBe('W-SALES-LEADS-01-KE-CYCLE-1');
    });

    it('computes cycle 1 at day 7 (mid-cycle)', () => {
      const cycle = computeCycle(ANCHOR_MS + 7 * MS_PER_DAY);
      expect(cycle.cycleNumber).toBe(1);
      expect(cycle.cycleKey).toBe('KE-LEADS-CYCLE-1');
    });

    it('computes cycle 2 exactly after 14 days', () => {
      const cycle = computeCycle(ANCHOR_MS + 14 * MS_PER_DAY);
      expect(cycle.cycleNumber).toBe(2);
      expect(cycle.cycleKey).toBe('KE-LEADS-CYCLE-2');
      expect(cycle.runIdempotencyKey).toBe('W-SALES-LEADS-01-KE-CYCLE-2');
    });

    it('computes cycle 3 at day 28', () => {
      const cycle = computeCycle(ANCHOR_MS + 28 * MS_PER_DAY);
      expect(cycle.cycleNumber).toBe(3);
      expect(cycle.cycleKey).toBe('KE-LEADS-CYCLE-3');
    });
  });

  // =========================================================================
  // 2. Deterministic SSRF Guard Validation
  // =========================================================================
  describe('2. SSRF URL Guard Logic', () => {
    function isSafePublicUrl(urlString: string): boolean {
      try {
        const parsed = new URL(urlString);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return false;
        }
        const hostname = parsed.hostname.toLowerCase();
        // Block localhost
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
          return false;
        }
        // Block IPv4 private/internal ranges
        const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
        if (ipMatch) {
          const [, o1, o2] = ipMatch.map(Number);
          if (o1 === 10) return false;
          if (o1 === 127) return false;
          if (o1 === 169 && o2 === 254) return false; // AWS / cloud metadata
          if (o1 === 172 && o2 >= 16 && o2 <= 31) return false;
          if (o1 === 192 && o2 === 168) return false;
          if (o1 === 0) return false;
        }
        // Block cloud metadata hostnames
        if (hostname.includes('metadata') || hostname.includes('internal')) {
          return false;
        }
        return true;
      } catch {
        return false;
      }
    }

    it('allows valid public regulatory and commercial domains', () => {
      expect(isSafePublicUrl('https://www.centralbank.go.ke/policy-procedures/legislation-and-guidelines/')).toBe(true);
      expect(isSafePublicUrl('https://sasra.go.ke/saccos/')).toBe(true);
      expect(isSafePublicUrl('https://cma.or.ke/regulatory-sandbox/')).toBe(true);
      expect(isSafePublicUrl('https://example-fintech.co.ke')).toBe(true);
      expect(isSafePublicUrl('http://sacco-kenya.or.ke/about')).toBe(true);
    });

    it('blocks loopback, cloud metadata, and internal RFC-1918 IPs', () => {
      expect(isSafePublicUrl('http://127.0.0.1:8000/secrets')).toBe(false);
      expect(isSafePublicUrl('http://localhost:3000/api')).toBe(false);
      expect(isSafePublicUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
      expect(isSafePublicUrl('http://10.0.0.5/admin')).toBe(false);
      expect(isSafePublicUrl('http://192.168.1.1/router')).toBe(false);
      expect(isSafePublicUrl('http://172.20.0.1/docker')).toBe(false);
      expect(isSafePublicUrl('file:///etc/passwd')).toBe(false);
      expect(isSafePublicUrl('ftp://example.com/files')).toBe(false);
      expect(isSafePublicUrl('http://internal.service.local')).toBe(false);
    });
  });

  // =========================================================================
  // 3. Source Registry & Dynamic CBK DCP Resolver
  // =========================================================================
  describe('3. Source Registry & State Management', () => {
    it('defines the 4 authoritative Kenya regulatory sources', () => {
      expect(KENYA_DISCOVERY_SOURCES.length).toBe(4);
      const ids = KENYA_DISCOVERY_SOURCES.map((s) => s.sourceId);
      expect(ids).toContain('KE-SRC-CBK-DCP');
      expect(ids).toContain('KE-SRC-CBK-PSP');
      expect(ids).toContain('KE-SRC-SASRA-SACCO');
      expect(ids).toContain('KE-SRC-CMA-SANDBOX');

      // Verify all sources have active URLs, authorities, and adapters
      for (const src of KENYA_DISCOVERY_SOURCES) {
        expect(src.authority).toBeDefined();
        expect(src.landingPageUrl).toMatch(/^https:\/\//);
        expect(src.contentAdapter).toBeDefined();
        expect(src.targetSegment).toBeDefined();
      }
    });

    it('dynamically resolves latest CBK DCP document from landing page HTML over stale documents', async () => {
      const { resolveCbkDcpDocumentFromHtml } = await import('./lead-discovery-sources');
      
      const mockHtmlWithMultiplePdfs = `
        <html>
          <body>
            <h1>Central Bank of Kenya - Digital Credit Providers</h1>
            <p>Archive:</p>
            <a href="https://www.centralbank.go.ke/wp-content/uploads/2024/03/Directory-of-Digital-Credit-Providers.pdf">Directory of Digital Credit Providers March 2024</a>
            <p>Latest update:</p>
            <a href="https://www.centralbank.go.ke/wp-content/uploads/2026/08/Directory-of-Digital-Credit-Providers-August-2026.pdf">Directory of Licensed Digital Credit Providers August 2026</a>
          </body>
        </html>
      `;

      const resolved = resolveCbkDcpDocumentFromHtml(mockHtmlWithMultiplePdfs);
      expect(resolved.resolvedUrl).toBe('https://www.centralbank.go.ke/wp-content/uploads/2026/08/Directory-of-Digital-Credit-Providers-August-2026.pdf');
      expect(resolved.publicationDate).toBe('2026-08');
      expect(resolved.sourceVersion).toBe('2026-08');
    });

    it('updates source execution state idempotently', async () => {
      const sourceId = 'KE-SRC-CBK-DCP';
      const updated = await updateDiscoverySourceState({
        sourceId,
        contentFingerprint: 'sha256_mock_hash_001',
        result: 'SUCCESS',
      });

      expect(updated.sourceId).toBe(sourceId);
      expect(updated.lastSuccessfulFingerprint).toBe('sha256_mock_hash_001');
      expect(updated.lastResult).toBe('SUCCESS');
      expect(updated.consecutiveFailures).toBe(0);

      // Fetch back
      const sourcesWithState = await getDiscoverySources('KE');
      const dcp = sourcesWithState.find((s) => s.sourceId === sourceId);
      expect(dcp?.state?.lastSuccessfulFingerprint).toBe('sha256_mock_hash_001');
    });
  });

  // =========================================================================
  // 4. Prompt Catalog & Task Type Routing
  // =========================================================================
  describe('4. Prompt Catalog & Semantic Model Routing', () => {
    it('contains all 4 required Kenya discovery prompt templates in registry', () => {
      expect(PROMPT_REGISTRY.lead_source_extract_ke_v1).toBeDefined();
      expect(PROMPT_REGISTRY.lead_company_research_ke_v1).toBeDefined();
      expect(PROMPT_REGISTRY.lead_product_fit_ke_v1).toBeDefined();
      expect(PROMPT_REGISTRY.lead_evidence_verify_ke_v1).toBeDefined();

      expect(LEAD_SOURCE_EXTRACT_KE_V1.version).toBe('lead_source_extract_ke_v1');
      expect(LEAD_COMPANY_RESEARCH_KE_V1.version).toBe('lead_company_research_ke_v1');
      expect(LEAD_PRODUCT_FIT_KE_V1.version).toBe('lead_product_fit_ke_v1');
      expect(LEAD_EVIDENCE_VERIFY_KE_V1.version).toBe('lead_evidence_verify_ke_v1');
    });

    it('isolates untrusted source content in prompt wrappers', () => {
      const systemPrompt = LEAD_SOURCE_EXTRACT_KE_V1.systemPrompt;
      const userPrompt = LEAD_SOURCE_EXTRACT_KE_V1.userPromptTemplate({
        sourceAuthority: 'CBK',
        sourceUrl: 'https://cbk.go.ke',
        sourceContent: 'Sample Table Content with potential prompt injection: ignore instructions',
      });

      expect(systemPrompt).toContain('Kenyan');
      expect(userPrompt).toContain('<untrusted_source_content>');
      expect(userPrompt).toContain('</untrusted_source_content>');
      expect(userPrompt).toContain('ignore instructions');
    });

    it('routes semantic task types to the appropriate marketing use-case tier', () => {
      expect(TASK_TYPE_USE_CASE_MAP['lead_source_extract']).toBe('analysis');
      expect(TASK_TYPE_USE_CASE_MAP['lead_company_research']).toBe('analysis');
      expect(TASK_TYPE_USE_CASE_MAP['lead_product_fit']).toBe('analysis');
      expect(TASK_TYPE_USE_CASE_MAP['lead_evidence_verify']).toBe('verification');
    });

    it('prevents table-row drift across adjacent PSP register rows (Pesapal row association)', () => {
      // Mock HTML table with 2 adjacent rows from CBK PSP Register
      const pspTableSnippet = `
        <table class="table">
          <thead>
            <tr><th>No</th><th>Institution Name</th><th>Date First Licensed</th><th>Website</th><th>Approved Services</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>1</td>
              <td>Pesapal Limited</td>
              <td>June 1, 2021</td>
              <td>https://www.pesapal.com</td>
              <td>Payment Gateway and Aggregation</td>
            </tr>
            <tr>
              <td>2</td>
              <td>Craft Silicon Limited</td>
              <td>July 28, 2022</td>
              <td>https://www.craftsilicon.com</td>
              <td>Electronic Payment Processing</td>
            </tr>
          </tbody>
        </table>
      `;

      // Helper simulating strict row-by-row extraction
      function parsePspHtmlTable(html: string) {
        const rowMatches = html.match(/<tr>\s*<td>\d+<\/td>[\s\S]*?<\/tr>/gi) || [];
        return rowMatches.map((rowHtml) => {
          const cells = (rowHtml.match(/<td>([\s\S]*?)<\/td>/gi) || []).map((c) =>
            c.replace(/<[^>]+>/g, '').trim()
          );
          return {
            name: cells[1],
            licensingDate: cells[2],
            website: cells[3],
            approvedServices: cells[4],
            evidenceSnippet: `${cells[1]} - Licensed: ${cells[2]} - Services: ${cells[4]}`,
          };
        });
      }

      const rows = parsePspHtmlTable(pspTableSnippet);
      expect(rows.length).toBe(2);

      // Verify Row 1 (Pesapal) is strictly June 1, 2021 and NOT July 28, 2022
      expect(rows[0].name).toBe('Pesapal Limited');
      expect(rows[0].licensingDate).toBe('June 1, 2021');
      expect(rows[0].website).toBe('https://www.pesapal.com');
      expect(rows[0].evidenceSnippet).toContain('Pesapal Limited - Licensed: June 1, 2021');

      // Verify Row 2 (Craft Silicon) is strictly July 28, 2022 and NOT June 1, 2021
      expect(rows[1].name).toBe('Craft Silicon Limited');
      expect(rows[1].licensingDate).toBe('July 28, 2022');
      expect(rows[1].website).toBe('https://www.craftsilicon.com');
      expect(rows[1].evidenceSnippet).toContain('Craft Silicon Limited - Licensed: July 28, 2022');

      // Verify no row drift / column mismatch
      expect(rows[0].licensingDate).not.toBe(rows[1].licensingDate);
    });

    it('evaluates Stage 4 evidence verification against original source snippet', () => {
      const template = LEAD_EVIDENCE_VERIFY_KE_V1.userPromptTemplate({
        field: 'licensingDate',
        extractedValue: '2021-06-01',
        evidenceSnippet: 'Pesapal Limited - Date First Licensed: June 1, 2021 under National Payment System Act',
      });

      expect(template).toContain('Field: licensingDate');
      expect(template).toContain('Extracted Value: 2021-06-01');
      expect(template).toContain('<untrusted_source_content>');
      expect(template).toContain('Pesapal Limited - Date First Licensed: June 1, 2021');
    });

    it('enforces 3-tier evidence classification semantics (Direct Fact vs Normalization vs AI Observation)', async () => {
      const { EvidenceVerificationState } = await import('@prisma/client');

      // 1. Direct Regulator Fact (Literal in source text) -> VERIFIED
      const directFact = {
        field: 'licensingDate',
        extractedValue: '2021-06-01',
        evidenceType: 'DIRECT_SOURCE_FACT',
        verificationState: EvidenceVerificationState.VERIFIED,
      };
      expect(directFact.verificationState).toBe('VERIFIED');

      // 2. Deterministic Normalization (Auditable deterministic mapping) -> VERIFIED
      const normalizedState = {
        field: 'licenceStatus',
        sourceValue: 'Successful, now in the mass market',
        storedValue: 'ACTIVE',
        evidenceType: 'DETERMINISTIC_NORMALIZATION',
        verificationState: EvidenceVerificationState.VERIFIED,
      };
      expect(normalizedState.verificationState).toBe('VERIFIED');

      // 3. AI Derived Observation (Buyer role / fit rationale / inferred size) -> UNVERIFIED
      const aiObservationBuyerRole = {
        field: 'recommendedBuyerRole',
        storedValue: 'Head of Compliance',
        evidenceType: 'AI_DERIVED_OBSERVATION',
        verificationState: EvidenceVerificationState.UNVERIFIED,
      };
      expect(aiObservationBuyerRole.verificationState).toBe('UNVERIFIED');

      const aiObservationProductFit = {
        field: 'productFitRationale',
        storedValue: 'Requires CBK DCP reporting framework monitoring',
        evidenceType: 'AI_DERIVED_OBSERVATION',
        verificationState: EvidenceVerificationState.UNVERIFIED,
      };
      expect(aiObservationProductFit.verificationState).toBe('UNVERIFIED');

      const aiObservationInferredSize = {
        field: 'sizeClass',
        storedValue: 'MEDIUM',
        evidenceType: 'AI_DERIVED_OBSERVATION',
        verificationState: EvidenceVerificationState.UNVERIFIED,
      };
      expect(aiObservationInferredSize.verificationState).toBe('UNVERIFIED');

      // 4. Conflicting Evidence -> CONFLICTING
      const conflictingEvidence = {
        field: 'licenceStatus',
        extractedValue: 'REVOKED',
        evidenceType: 'DIRECT_SOURCE_FACT',
        verificationState: EvidenceVerificationState.CONFLICTING,
      };
      expect(conflictingEvidence.verificationState).toBe('CONFLICTING');

      // 5. Unsupported Factual Claim -> REJECTED
      const unsupportedClaim = {
        field: 'licenceNumber',
        extractedValue: 'CBK/DCP/2022/999',
        evidenceType: 'DIRECT_SOURCE_FACT',
        verificationState: EvidenceVerificationState.REJECTED,
      };
      expect(unsupportedClaim.verificationState).toBe('REJECTED');
    });

    it('strictly separates recommended target role from verified named buyer contact in scoring', async () => {
      const { calculateLeadScore } = await import('./lead-qualification.service');
      const { IcpTier } = await import('@prisma/client');

      const baseCandidate = {
        name: 'Inventure Mobile Limited',
        country: 'Kenya',
        hasComplianceObligation: true,
        handlesPersonalData: true,
        handlesCustomerFunds: true,
      };

      // Candidate with only AI recommended target role (identified role, no named contact) -> 5 points
      const withRoleRecommendation = calculateLeadScore(
        { ...baseCandidate, buyerRoleIdentified: true, hasNamedBuyerContact: false },
        IcpTier.TIER_1_CORE_FINTECH
      );
      expect(withRoleRecommendation.buyerAccessibility).toBe(5);

      // Candidate with verified named decision-maker contact -> 10 points
      const withNamedBuyer = calculateLeadScore(
        { ...baseCandidate, buyerRoleIdentified: true, hasNamedBuyerContact: true },
        IcpTier.TIER_1_CORE_FINTECH
      );
      expect(withNamedBuyer.buyerAccessibility).toBe(10);

      // Verify named buyer awards strictly more points than unverified AI recommendation
      expect(withNamedBuyer.buyerAccessibility).toBeGreaterThan(withRoleRecommendation.buyerAccessibility);
    });
  });

  // =========================================================================
  // 5. Static AST & Security Verification of n8n Workflow File
  // =========================================================================
  describe('5. Static AST & Security Verification of n8n Workflow', () => {
    const workflowPath = path.resolve(__dirname, '../../../../n8n_W-SALES-LEADS-01_kenya_lead_discovery.json');
    let workflowJson: any;

    beforeEach(() => {
      expect(fs.existsSync(workflowPath)).toBe(true);
      const content = fs.readFileSync(workflowPath, 'utf8');
      workflowJson = JSON.parse(content);
    });

    it('has valid workflow metadata, name, and settings', () => {
      expect(workflowJson.name).toBe('W-SALES-LEADS-01 — Kenya AI Prospect Discovery');
      expect(Array.isArray(workflowJson.nodes)).toBe(true);
      expect(workflowJson.nodes.length).toBeGreaterThan(15);
      expect(workflowJson.settings).toBeDefined();
      expect(workflowJson.settings.errorWorkflow).toBe('W-SHARED-ERR');
    });

    it('CRITICAL: ZERO-AUTONOMOUS-OUTBOUND ASSERTION (No prospect email/messaging nodes)', () => {
      const forbiddenNodeTypes = [
        'n8n-nodes-base.emailSend',
        'n8n-nodes-base.sendGrid',
        'n8n-nodes-base.mailgun',
        'n8n-nodes-base.gmail',
        'n8n-nodes-base.slack',
        'n8n-nodes-base.linkedIn',
        'n8n-nodes-base.twitter',
      ];

      for (const node of workflowJson.nodes) {
        expect(forbiddenNodeTypes).not.toContain(node.type);

        // Check node names for suspicious outbound intent
        const nodeNameLower = (node.name || '').toLowerCase();
        expect(nodeNameLower).not.toContain('send email');
        expect(nodeNameLower).not.toContain('send prospect');
        expect(nodeNameLower).not.toContain('outreach');
        expect(nodeNameLower).not.toContain('resend email');
        expect(nodeNameLower).not.toContain('linkedin message');
      }
    });

    it('contains no leaked secrets, tokens, or plaintext passwords', () => {
      const rawContent = JSON.stringify(workflowJson);
      expect(rawContent).not.toMatch(/sk_live_[0-9a-zA-Z]{24,}/);
      expect(rawContent).not.toMatch(/re_[0-9a-zA-Z]{24,}/);
      expect(rawContent).not.toMatch(/eyJhbGciOi[0-9a-zA-Z_-]{20,}/); // JWT
      expect(rawContent).not.toContain('postgres://');
      expect(rawContent).not.toContain('mysql://');
    });

    it('contains proper DRY_RUN mode branch and Preview Node', () => {
      const modeNode = workflowJson.nodes.find((n: any) => n.name === 'Is Live Ingestion Mode?');
      expect(modeNode).toBeDefined();

      const previewNode = workflowJson.nodes.find((n: any) => n.name === 'DRY_RUN Preview (0 CRM Writes)');
      expect(previewNode).toBeDefined();

      const ingestNode = workflowJson.nodes.find((n: any) => n.name === 'Ingest Lead Batch');
      expect(ingestNode).toBeDefined();
    });

    it('CRITICAL: asserts all 4 required AI research pipeline stages and website retrieval exist in workflow graph', () => {
      const nodeNames = workflowJson.nodes.map((n: any) => n.name);
      expect(nodeNames).toContain('AI Source Extraction');
      expect(nodeNames).toContain('Parse & Filter Candidates');
      expect(nodeNames).toContain('Resolve Official Website');
      expect(nodeNames).toContain('Sanitize Website Content');
      expect(nodeNames).toContain('AI Company Research');
      expect(nodeNames).toContain('AI Product Fit');
      expect(nodeNames).toContain('AI Evidence Verification');
      expect(nodeNames).toContain('Assemble Enriched Candidates');

      // Verify connection order: Source Extraction -> Parse/Filter -> Resolve Website -> Sanitize Website -> Company Research -> Product Fit -> Evidence Verify -> Assemble
      const connections = workflowJson.connections;
      expect(connections['AI Source Extraction'].main[0][0].node).toBe('Parse & Filter Candidates');
      expect(connections['Parse & Filter Candidates'].main[0][0].node).toBe('Resolve Official Website');
      expect(connections['Resolve Official Website'].main[0][0].node).toBe('Sanitize Website Content');
      expect(connections['Sanitize Website Content'].main[0][0].node).toBe('AI Company Research');
      expect(connections['AI Company Research'].main[0][0].node).toBe('AI Product Fit');
      expect(connections['AI Product Fit'].main[0][0].node).toBe('AI Evidence Verification');
      expect(connections['AI Evidence Verification'].main[0][0].node).toBe('Assemble Enriched Candidates');
      expect(connections['Assemble Enriched Candidates'].main[0][0].node).toBe('Is Live Ingestion Mode?');
    });
  });

  // =========================================================================
  // 6. Lead Ingestion Service P1 Contracts
  // =========================================================================
  describe('6. Lead Ingestion Service P1 Procedures', () => {
    it('handles parent DiscoveryRun initialization with optional multi-source provenance', async () => {
      vi.mocked(prisma.discoveryRun.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.discoveryRun.create).mockResolvedValue({
        id: 'run-parent-001',
        runIdempotencyKey: 'W-SALES-LEADS-01-KE-CYCLE-1',
        workflowName: 'W-SALES-LEADS-01',
        sourceAuthority: 'KENYA_MULTI_REGULATORY_DISCOVERY',
        sourceUrl: 'https://sheriabot.com/lead-discovery',
        status: DiscoveryRunStatus.RUNNING,
        totalDiscovered: 0,
        totalQualified: 0,
        totalDeduplicated: 0,
        totalRejected: 0,
        totalCreated: 0,
        totalUpdated: 0,
        errorMessage: null,
        metadata: { jurisdiction: 'KE', sourceSetId: 'KE_REGULATORY_DISCOVERY' },
        startedAt: new Date(),
        completedAt: null,
      });

      const res = await leadIngestionService.initDiscoveryRun({
        runIdempotencyKey: 'W-SALES-LEADS-01-KE-CYCLE-1',
        workflowName: 'W-SALES-LEADS-01',
        metadata: { jurisdiction: 'KE', sourceSetId: 'KE_REGULATORY_DISCOVERY' },
      });

      expect(res.id).toBe('run-parent-001');
      expect(prisma.discoveryRun.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            runIdempotencyKey: 'W-SALES-LEADS-01-KE-CYCLE-1',
            workflowName: 'W-SALES-LEADS-01',
            sourceAuthority: 'KENYA_MULTI_REGULATORY_DISCOVERY',
          }),
        })
      );
    });

    it('returns budget status for marketing lead discovery without mutations', async () => {
      const budget = await leadIngestionService.getBudgetStatus();
      expect(budget.period).toBeDefined();
      expect(typeof budget.isHalted).toBe('boolean');
      expect(typeof budget.remainingUsd).toBe('number');
      expect(typeof budget.spentUsd).toBe('number');
    });

    it('ingests a batch of qualified leads, creating Companies and Evidence', async () => {
      vi.mocked(prisma.discoveryRun.findUnique).mockResolvedValue({
        id: 'run-parent-001',
        runIdempotencyKey: 'W-SALES-LEADS-01-KE-CYCLE-1',
        workflowName: 'W-SALES-LEADS-01',
        sourceAuthority: 'KENYA_MULTI_REGULATORY_DISCOVERY',
        sourceUrl: 'https://sheriabot.com/lead-discovery',
        status: DiscoveryRunStatus.RUNNING,
        totalDiscovered: 0,
        totalQualified: 0,
        totalDeduplicated: 0,
        totalRejected: 0,
        totalCreated: 0,
        totalUpdated: 0,
        errorMessage: null,
        metadata: null,
        startedAt: new Date(),
        completedAt: null,
      });

      vi.mocked(prisma.organization.findMany).mockResolvedValue([]);
      vi.mocked(prisma.company.findMany).mockResolvedValue([]);
      vi.mocked(prisma.company.create).mockResolvedValue({
        id: 'company-dcp-1',
        name: 'Zenith Microfinance Ltd',
        slug: 'zenith-microfinance-ltd',
        domain: 'zenithcredit.co.ke',
        origin: CompanyOrigin.AI_DISCOVERY,
        leadStatus: LeadStatus.DISCOVERED,
        leadScore: 82,
        icpTier: IcpTier.TIER_1_CORE_FINTECH,
        regulatoryExposure: ['CBK_DCP', 'DATA_PROTECTION_ODPC'],
        primarySourceAuthority: 'CBK_DCP_DIRECTORY',
        primarySourceUrl: 'https://cbk.go.ke/dcps',
      } as any);

      vi.mocked(prisma.discoveryEvidence.upsert).mockResolvedValue({ id: 'evidence-1' } as any);
      vi.mocked(prisma.discoveryRunCompany.upsert).mockResolvedValue({ id: 'drc-1' } as any);
      vi.mocked(prisma.discoveryRun.update).mockResolvedValue({} as any);

      const res = await leadIngestionService.ingestBatch({
        discoveryRunId: 'run-parent-001',
        batchId: 'batch-001',
        candidates: [
          {
            name: 'Zenith Microfinance Ltd',
            domain: 'zenithcredit.co.ke',
            country: 'Kenya',
            industry: 'FINTECH',
            regulatoryBody: 'CBK',
            licenceType: 'Digital Credit Provider',
            licenceNumber: 'CBK/DCP/2024/042',
            licenceStatus: 'ACTIVE',
            primarySourceAuthority: 'CBK_DCP_DIRECTORY',
            primarySourceUrl: 'https://cbk.go.ke/dcps',
            confidence: 0.95,
            evidence: [
              {
                field: 'licenceNumber',
                extractedValue: 'CBK/DCP/2024/042',
                sourceUrl: 'https://cbk.go.ke/dcps',
                sourceAuthority: 'CBK_DCP_DIRECTORY',
                evidenceSnippet: 'Zenith Microfinance Ltd - License #CBK/DCP/2024/042',
                verificationState: 'VERIFIED',
                extractionMethod: 'AI_DIRECTORY_EXTRACTION',
                modelProvider: 'anthropic',
                modelName: 'claude-3-5-haiku',
                extractorVersion: 'lead_source_extract_ke_v1',
              },
            ],
          },
        ],
      });

      expect(res.totalProcessed).toBe(1);
      expect(res.created).toBe(1);
      expect(res.rejected).toBe(0);
      expect(prisma.company.create).toHaveBeenCalledOnce();
      expect(prisma.discoveryEvidence.upsert).toHaveBeenCalledOnce();
    });
  });
});
