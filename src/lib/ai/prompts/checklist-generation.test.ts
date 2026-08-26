import { describe, expect, it } from 'vitest';
import {
  GeneratedChecklistSchema,
  deduplicateChecklistCategories,
  ChecklistCategory,
  parseWithTierSchema,
} from './checklist-generation';

function sampleCategory(name: string, titles: string[]): ChecklistCategory {
  return {
    id: name.slice(0, 3).toUpperCase(),
    name,
    description: `Substantive regulatory requirements for ${name}`,
    items: titles.map((title, idx) => ({
      id: `${name.slice(0, 3).toUpperCase()}-${String(idx + 1).padStart(3, '0')}`,
      title,
      description: `Requirement details and statutory controls for ${title}`,
      priority: 'HIGH' as const,
      actionItems: [`Implement full operational compliance controls for ${title}`],
      regulatoryBasis: 'National Payment Systems Act, Section 12',
      deadline: '90 days',
      penalty: 'Statutory fine pursuant to Central Bank of Kenya directives',
    })),
  };
}

describe('Checklist Completeness & Deduplication Hardening', () => {
  describe('GeneratedChecklistSchema Completeness Contract', () => {
    it('validates a complete checklist with metadata contract', () => {
      const payload = {
        categories: [
          sampleCategory('Licensing', ['Obtain Central Bank PSP License']),
          sampleCategory('Cybersecurity', ['Appoint Chief Information Security Officer']),
          sampleCategory('AML Compliance', ['Deploy Transaction Monitoring and STR Reporting']),
        ],
        metadata: {
          productType: 'Payment Service Provider',
          businessStage: 'Operational Fintech',
          totalItems: 3,
          criticalItems: 0,
          highItems: 3,
          estimatedCompletionDays: 90,
          generatedAt: new Date().toISOString(),
          ragSourcesUsed: 4,
          generationStatus: 'COMPLETE' as const,
          generationComplete: true,
          expectedCategories: 3,
          completedCategories: 3,
          truncated: false,
        },
      };

      const result = GeneratedChecklistSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.metadata.generationStatus).toBe('COMPLETE');
        expect(result.data.metadata.generationComplete).toBe(true);
        expect(result.data.metadata.truncated).toBe(false);
      }
    });

    it('validates a partial checklist with explicit PARTIAL status and truncated flag', () => {
      const payload = {
        categories: [
          sampleCategory('Licensing', ['Obtain Central Bank PSP License']),
          sampleCategory('Cybersecurity', ['Appoint Chief Information Security Officer']),
          sampleCategory('AML Compliance', ['Deploy Transaction Monitoring and STR Reporting']),
        ],
        metadata: {
          productType: 'Payment Service Provider',
          businessStage: 'Operational Fintech',
          totalItems: 3,
          criticalItems: 0,
          highItems: 3,
          estimatedCompletionDays: 90,
          generatedAt: new Date().toISOString(),
          ragSourcesUsed: 4,
          generationStatus: 'PARTIAL' as const,
          generationComplete: false,
          expectedCategories: 5,
          completedCategories: 3,
          truncated: true,
        },
      };

      const result = GeneratedChecklistSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.metadata.generationStatus).toBe('PARTIAL');
        expect(result.data.metadata.generationComplete).toBe(false);
        expect(result.data.metadata.truncated).toBe(true);
      }
    });
  });

  describe('deduplicateChecklistCategories', () => {
    it('detects and removes exact duplicate items across categories', () => {
      const categories: ChecklistCategory[] = [
        sampleCategory('Licensing', ['Obtain Central Bank PSP License', 'Submit annual audited accounts to CBK']),
        sampleCategory('Governance', ['Obtain Central Bank PSP License', 'Appoint Independent Compliance Officer']),
      ];

      const { categories: deduped, duplicatesRemoved, duplicateLog } = deduplicateChecklistCategories(categories);

      expect(duplicatesRemoved).toBe(1);
      expect(duplicateLog).toHaveLength(1);
      expect(duplicateLog[0].originalTitle).toBe('Obtain Central Bank PSP License');
      expect(deduped[0].items).toHaveLength(2);
      expect(deduped[1].items).toHaveLength(1);
      expect(deduped[1].items[0].title).toBe('Appoint Independent Compliance Officer');
    });

    it('preserves distinct requirements with different titles and bases', () => {
      const categories: ChecklistCategory[] = [
        sampleCategory('Licensing', ['Obtain Central Bank PSP License', 'Submit annual audited accounts to CBK']),
        sampleCategory('Governance', ['Establish Board Audit Committee', 'Appoint Independent Compliance Officer']),
      ];

      const { categories: deduped, duplicatesRemoved } = deduplicateChecklistCategories(categories);

      expect(duplicatesRemoved).toBe(0);
      expect(deduped[0].items).toHaveLength(2);
      expect(deduped[1].items).toHaveLength(2);
    });
  });

  describe('parseWithTierSchema Completeness UAT (Cases A-E)', () => {
    const logCtx = {
      checklistId: 'test-chk-1',
      input: { productType: 'Payment Service Provider', businessStage: 'Operational Fintech' },
      ragSourcesUsed: 5,
    };

    const validFullTierPayload = {
      categories: [
        sampleCategory('Licensing & Authorisation', [
          'Obtain Central Bank Authorisation as Payment Service Provider',
          'Submit Certified Certificate of Incorporation and Articles',
          'Provide Three-Year Comprehensive Business and Financial Plan',
        ]),
        sampleCategory('Cybersecurity & Incident Management', [
          'Appoint Dedicated Chief Information Security Officer',
          'Implement Central Bank Cybersecurity Risk Management Framework',
          'Conduct Annual Third-Party Penetration Testing and Vulnerability Assessment',
        ]),
      ],
      metadata: {
        productType: 'Payment Service Provider',
        businessStage: 'Operational Fintech',
        totalItems: 6,
        criticalItems: 2,
        highItems: 4,
        estimatedCompletionDays: 90,
        generatedAt: '2026-08-26T12:00:00.000Z',
        ragSourcesUsed: 5,
        generationStatus: 'COMPLETE',
        generationComplete: true,
        truncated: false,
      },
    };

    it('Case A: Complete checklist returns COMPLETE and generationComplete=true', () => {
      const raw = JSON.stringify(validFullTierPayload);
      const parsed = parseWithTierSchema(raw, 3, logCtx);

      expect(parsed.metadata.generationStatus).toBe('COMPLETE');
      expect(parsed.metadata.generationComplete).toBe(true);
      expect(parsed.metadata.truncated).toBe(false);
      expect(parsed.categories).toHaveLength(2);
    });

    it('Case B: Truncated response with recoverable categories returns PARTIAL status', () => {
      const truncatedWithInvalid = {
        categories: [
          ...validFullTierPayload.categories,
          { id: 'INV', name: 'Incomplete Cat' }, // Malformed incomplete trailing category
        ],
        metadata: validFullTierPayload.metadata,
      };

      const parsed = parseWithTierSchema(JSON.stringify(truncatedWithInvalid), 3, logCtx);
      expect(parsed.metadata.generationStatus).toBe('PARTIAL');
      expect(parsed.metadata.generationComplete).toBe(false);
      expect(parsed.metadata.truncated).toBe(true);
      expect(parsed.categories).toHaveLength(2);
    });

    it('Case C: Incomplete response with fewer categories than expected marks PARTIAL', () => {
      const fewerCategories = {
        categories: validFullTierPayload.categories.slice(0, 1),
        metadata: {
          ...validFullTierPayload.metadata,
          expectedCategories: 4,
        },
      };

      const parsed = parseWithTierSchema(JSON.stringify(fewerCategories), 3, logCtx);
      expect(parsed.metadata.generationStatus).toBe('PARTIAL');
      expect(parsed.metadata.generationComplete).toBe(false);
      expect(parsed.metadata.completedCategories).toBe(1);
      expect(parsed.metadata.expectedCategories).toBe(4);
    });

    it('Case D: Truncated JSON syntax string repaired by extractJsonObject marks PARTIAL', () => {
      const validPart = {
        categories: validFullTierPayload.categories,
        metadata: {
          ...validFullTierPayload.metadata,
          truncated: true,
        },
      };

      const raw = JSON.stringify(validPart);
      const parsed = parseWithTierSchema(raw, 3, logCtx);
      expect(parsed.metadata.generationStatus).toBe('PARTIAL');
      expect(parsed.metadata.generationComplete).toBe(false);
      expect(parsed.metadata.truncated).toBe(true);
    });

    it('Case E: Malformed output with insufficient valid categories throws and never returns COMPLETE', () => {
      const unrecoverable = JSON.stringify({
        categories: [
          { invalidCategory: true },
        ],
      });

      expect(() => parseWithTierSchema(unrecoverable, 1, logCtx)).toThrow();
    });
  });
});
