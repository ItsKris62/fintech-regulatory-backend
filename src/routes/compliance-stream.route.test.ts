import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildComplianceRagQuery,
  extractNamedRegulations,
  checkAndPrepareUsage,
  getFallbackReasonForRetrieval,
  hasUsableRetrievedChunks,
  selectGenerationSources,
} from './compliance-stream.route';
import { redis } from '@/lib/redis/client';
import * as trialUsage from '@/modules/trial';
import { generateComplianceUserPrompt } from '@/lib/ai/prompts/compliance-query';
import { buildCitationsFromChunks } from '@/lib/source-grounding/citations';
import type { SearchResult } from '@/lib/rag/rag.service';

vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: vi.fn(),
    incrby: vi.fn(),
    expire: vi.fn(),
  },
}));

vi.mock('@/modules/trial', () => ({
  checkTrialLimit: vi.fn(),
  incrementTrialUsageAtomic: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {},
}));

describe('Compliance Stream Routing & Billing Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('extractNamedRegulations', () => {
    it('1. extracts a single regulation by name', () => {
      const q = "Does the Data Protection Act apply here?";
      expect(extractNamedRegulations(q)).toEqual(["Data Protection Act"]);
    });

    it('2. extracts multiple named regulations', () => {
      const q = "According to the Data Protection Act and CBK Guidelines 2024, what should we do?";
      expect(extractNamedRegulations(q)).toEqual(["Data Protection Act", "CBK Guidelines 2024"]);
    });

    it('3. handles regulations with years', () => {
      const q = "What does the National Payment System Act 2011 say?";
      expect(extractNamedRegulations(q)).toEqual(["National Payment System Act 2011"]);
    });

    it('4. ignores generic non-capitalized terms', () => {
      const q = "What does the new act say about these regulations?";
      expect(extractNamedRegulations(q)).toEqual([]);
    });
  });

  describe('RAG retrieval helpers', () => {
    it('soft-boosts AML and payment service provider queries without removing the original question', () => {
      const question = 'What are the AML obligations for a payment service provider in Kenya?';
      const ragQuery = buildComplianceRagQuery(question, extractNamedRegulations(question));

      expect(ragQuery).toContain(question);
      expect(ragQuery).toContain('AML/CFT');
      expect(ragQuery).toContain('Financial Reporting Centre');
      expect(ragQuery).toContain('Central Bank of Kenya');
      expect(ragQuery).toContain('payment service provider');
    });

    it('soft-boosts data protection and mobile money queries across ODPC and CBK terms', () => {
      const question = 'How do I comply with the Data Protection Act for mobile money services?';
      const ragQuery = buildComplianceRagQuery(question, extractNamedRegulations(question));

      expect(ragQuery).toContain(question);
      expect(ragQuery).toContain('Data Protection Act');
      expect(ragQuery).toContain('ODPC');
      expect(ragQuery).toContain('Central Bank of Kenya');
      expect(ragQuery).toContain('mobile money');
    });

    it('keeps imaginary fintech regulation queries in retrieval instead of classifying them as outside scope', () => {
      const question = 'How do I comply with the imaginary Fintech Unicorn Act 2027?';
      const ragQuery = buildComplianceRagQuery(question, extractNamedRegulations(question));

      expect(ragQuery).toContain(question);
      expect(ragQuery).toContain('Fintech Unicorn Act 2027');
      expect(ragQuery).toContain('Kenya fintech compliance');
    });

    it('uses jurisdiction-specific boosts when a non-Kenya context is supplied', () => {
      const question = 'What licensing rules apply to a payment fintech in Rwanda?';
      const ragQuery = buildComplianceRagQuery(
        question,
        extractNamedRegulations(question),
        {
          mode: 'SINGLE',
          jurisdictions: ['RW'],
          primaryJurisdiction: 'RW',
          jurisdictionSource: 'REQUEST',
        },
      );

      expect(ragQuery).toContain('National Bank of Rwanda');
      expect(ragQuery).toContain('Rwanda fintech compliance');
      expect(ragQuery).not.toContain('Central Bank of Kenya');
      expect(ragQuery).not.toContain('Kenya fintech compliance');
    });

    it('uses explicit fallback reasons for no retrieval and post-retrieval insufficiency', () => {
      expect(getFallbackReasonForRetrieval(0, null)).toBe('NO_RAG_CHUNKS');
      expect(getFallbackReasonForRetrieval(3, '')).toBe('LOW_RELEVANCE');
    });

    it('treats chunks with title and content as usable even when section metadata is missing', () => {
      expect(hasUsableRetrievedChunks([
        {
          documentTitle: 'Kenya Data Protection Act, 2019',
          chunkText: 'A data controller shall process personal data lawfully.',
        },
      ])).toBe(true);
    });

    it('does not fail open when the grader fails without accepted chunks', () => {
      const retrieved = [{ id: 'chunk-1' }];
      const selected = selectGenerationSources(retrieved, [], true);

      expect(selected.sources).toEqual([]);
      expect(selected.usedVerifierFallback).toBe(false);
      expect(selected.allChunksFailedVerification).toBe(true);
      expect(selected.externalProviderBillingBlocked).toBe(false);
    });

    it('classifies provider billing failures separately from evidence insufficiency', () => {
      const retrieved = [{ id: 'chunk-1' }];
      const selected = selectGenerationSources(retrieved, [], true, {
        failureClassification: 'EXTERNAL_PROVIDER_BILLING_BLOCKER',
      } as any);

      expect(selected.sources).toEqual([]);
      expect(selected.usedVerifierFallback).toBe(false);
      expect(selected.allChunksFailedVerification).toBe(false);
      expect(selected.externalProviderBillingBlocked).toBe(true);
    });

    it('triggers all-chunks-failed when verification completes with zero accepted chunks', () => {
      const selected = selectGenerationSources([{ id: 'chunk-1' }], [], false);

      expect(selected.sources).toEqual([]);
      expect(selected.usedVerifierFallback).toBe(false);
      expect(selected.allChunksFailedVerification).toBe(true);
      expect(selected.externalProviderBillingBlocked).toBe(false);
    });

    it('returns referenced documents from actual retrieved chunks even without section metadata', () => {
      const chunk: SearchResult = {
        vectorId: 'doc-1-chunk-0',
        chunkId: 'doc-1-chunk-0',
        documentId: 'doc-1',
        documentTitle: 'National Payment System Act 2011',
        jurisdictionCode: 'KE',
        jurisdiction: 'Kenya',
        chunkText: 'A payment service provider must comply with requirements issued by the Central Bank.',
        score: 0.91,
        rank: 1,
      };

      const citations = buildCitationsFromChunks([chunk], 'not_checked');

      expect(citations).toHaveLength(1);
      expect(citations[0]).toMatchObject({
        documentId: 'doc-1',
        documentTitle: 'National Payment System Act 2011',
        verificationStatus: 'not_checked',
      });
    });
  });

  describe('Compliance answer prompt detail levels', () => {
    it('Detailed mode asks for a longer grounded answer than Standard mode', () => {
      const baseParams = {
        question: 'What KYC requirements apply to fintech startups in Kenya?',
        ragContext: '[Document: POCAMLA]\nKYC obligations and records.\n---',
      };
      const standard = generateComplianceUserPrompt({ ...baseParams, answerDetail: 'standard' });
      const detailed = generateComplianceUserPrompt({ ...baseParams, answerDetail: 'detailed' });

      expect(detailed.length).toBeGreaterThan(standard.length);
      expect(detailed).toContain('## Executive Summary');
      expect(detailed).toContain('## Recommended Controls');
      expect(detailed).toContain('## Referenced Documents and Sections');
    });
  });

  describe('fallback copy hygiene', () => {
    it('does not contain old missing-source fallback text in frontend or backend source', () => {
      const repoRoot = join(__dirname, '..', '..', '..');
      const roots = [
        join(repoRoot, 'src'),
        join(repoRoot, '..', 'fintech-regulatory-platform', 'components'),
        join(repoRoot, '..', 'fintech-regulatory-platform', 'app'),
        join(repoRoot, '..', 'fintech-regulatory-platform', 'hooks'),
      ];
      const forbidden = [
        "This regulation isn't " + 'currently',
        "relevant regulation hasn't been " + 'indexed',
      ];

      const files: string[] = [];
      const walk = (dir: string): void => {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
            files.push(fullPath);
          }
        }
      };
      roots.forEach(walk);

      const offenders = files.filter((file) => {
        const content = readFileSync(file, 'utf8');
        return forbidden.some((text) => content.includes(text));
      });

      expect(offenders).toEqual([]);
    });
  });

  describe('checkAndPrepareUsage', () => {
    const defaultAuth = {
      userId: 'user1',
      organizationId: 'org1',
      plan: 'STARTUP' as const,
      features: ['complianceQuery'],
      entitlements: {
        complianceQueries: { limit: 500, period: 'monthly' },
      },
    };

    it('5. allows standard query if quota allows (1 credit)', async () => {
      vi.mocked(redis.get).mockResolvedValue(5);
      const result = await checkAndPrepareUsage(defaultAuth as any, 1);
      expect(result.allowed).toBe(true);
      expect(result.statusCode).toBe(429);
    });

    it('6. allows detailed query if quota allows (2 credits)', async () => {
      vi.mocked(redis.get).mockResolvedValue(498);
      const result = await checkAndPrepareUsage(defaultAuth as any, 2);
      expect(result.allowed).toBe(true);
    });

    it('7. rejects detailed query if only 1 credit remaining', async () => {
      vi.mocked(redis.get).mockResolvedValue(499);
      const result = await checkAndPrepareUsage(defaultAuth as any, 2);
      expect(result.allowed).toBe(false);
      expect(result.statusCode).toBe(429);
      expect(result.message).toContain("Detailed answers require 2 query credits");
    });

    it('8. rejects standard query if 0 credits remaining', async () => {
      vi.mocked(redis.get).mockResolvedValue(500);
      const result = await checkAndPrepareUsage(defaultAuth as any, 1);
      expect(result.allowed).toBe(false);
      expect(result.statusCode).toBe(429);
      expect(result.message).toContain("Monthly limit reached");
    });

    it('9. returns a deferred increment function that consumes correct credits', async () => {
      vi.mocked(redis.get).mockResolvedValue(5);
      vi.mocked(redis.incrby).mockResolvedValue(7);
      const result = await checkAndPrepareUsage(defaultAuth as any, 2);
      expect(result.allowed).toBe(true);
      
      await result.increment();
      expect(redis.incrby).toHaveBeenCalledWith(expect.any(String), 2);
    });

    it('10. handles FREE_TRIAL quotas correctly, rejecting if limit reached', async () => {
      const trialAuth = { ...defaultAuth, plan: 'FREE_TRIAL' as const };
      vi.mocked(trialUsage.checkTrialLimit).mockResolvedValueOnce({
        allowed: true,
        current: 19,
        limit: 20,
      }); // Only 1 query left

      const result = await checkAndPrepareUsage(trialAuth as any, 2);
      expect(result.allowed).toBe(false);
      expect(result.statusCode).toBe(403);
      expect(result.message).toContain("Detailed answers require 2 query credits");
    });
  });
});
