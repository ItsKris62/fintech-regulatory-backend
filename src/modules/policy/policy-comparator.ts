/**
 * Policy Comparator
 * Handles comparison between policies and coverage analysis
 */

import { aiService } from '@/lib/ai/ai.service';
import { logger } from '@/utils/logger';
import {
  type PolicyWithDetails,
  type ComparisonResult,
  type PolicySummary,
  type SimilarityItem,
  type DifferenceItem,
  type CoverageAnalysis,
  type CoverageGap,
  type RegulatoryArea,
  PolicyError,
} from './policy.types';
import {
  extractSections,
  countWords,
  getRegulatoryAreaName,
  getRegulatoryAuthority,
} from './policy.utils';

/**
 * Policy Comparator Class
 * Analyzes and compares multiple policies
 */
export class PolicyComparator {
  /**
   * Compare multiple policies
   */
  async compare(policies: PolicyWithDetails[]): Promise<ComparisonResult> {
    logger.info({
      type: 'policy_comparison_started',
      policyCount: policies.length,
      policyIds: policies.map(p => p.id),
    });

    if (policies.length < 2) {
      throw new PolicyError(
        'At least 2 policies are required for comparison',
        'COMPARISON_FAILED',
        400
      );
    }

    try {
      // Create policy summaries
      const summaries = policies.map(this.createPolicySummary);

      // Find similarities
      const similarities = await this.findSimilarities(policies);

      // Find differences
      const differences = await this.findDifferences(policies);

      // Analyze coverage
      const coverage = this.analyzeCoverage(policies);

      // Generate recommendations
      const recommendations = await this.generateRecommendations(
        policies,
        similarities,
        differences,
        coverage
      );

      logger.info({
        type: 'policy_comparison_completed',
        similaritiesCount: similarities.length,
        differencesCount: differences.length,
      });

      return {
        policies: summaries,
        similarities,
        differences,
        coverage,
        recommendations,
        generatedAt: new Date(),
      };
    } catch (error: any) {
      logger.error({
        type: 'policy_comparison_error',
        error: error.message,
      });

      throw new PolicyError(
        `Comparison failed: ${error.message}`,
        'COMPARISON_FAILED',
        500
      );
    }
  }

  /**
   * Compare two policies in detail
   */
  async compareTwoPolicies(
    policyA: PolicyWithDetails,
    policyB: PolicyWithDetails
  ): Promise<{
    summary: string;
    similarities: SimilarityItem[];
    differences: DifferenceItem[];
    recommendation: string;
  }> {
    logger.info({
      type: 'policy_pair_comparison_started',
      policyA: policyA.id,
      policyB: policyB.id,
    });

    const sectionsA = extractSections(policyA.content);
    const sectionsB = extractSections(policyB.content);

    // Find matching sections
    const similarities: SimilarityItem[] = [];
    const differences: DifferenceItem[] = [];

    // Compare sections by title similarity
    for (const sectionA of sectionsA) {
      const matchingSection = sectionsB.find(
        sB => this.calculateSimilarity(sectionA.title, sB.title) > 0.7
      );

      if (matchingSection) {
        const contentSimilarity = this.calculateSimilarity(
          sectionA.content,
          matchingSection.content
        );

        if (contentSimilarity > 0.8) {
          similarities.push({
            area: sectionA.title,
            description: `Both policies address "${sectionA.title}" with similar content`,
            policies: [policyA.id, policyB.id],
            matchPercentage: Math.round(contentSimilarity * 100),
          });
        } else {
          differences.push({
            area: sectionA.title,
            description: `Different approaches to "${sectionA.title}"`,
            policyA: { id: policyA.id, content: this.truncate(sectionA.content, 200) },
            policyB: { id: policyB.id, content: this.truncate(matchingSection.content, 200) },
            significance: contentSimilarity < 0.5 ? 'high' : 'medium',
          });
        }
      } else {
        differences.push({
          area: sectionA.title,
          description: `"${sectionA.title}" only present in first policy`,
          policyA: { id: policyA.id, content: this.truncate(sectionA.content, 200) },
          policyB: null,
          significance: 'medium',
        });
      }
    }

    // Find sections only in B
    for (const sectionB of sectionsB) {
      const matchingSection = sectionsA.find(
        sA => this.calculateSimilarity(sectionB.title, sA.title) > 0.7
      );

      if (!matchingSection) {
        differences.push({
          area: sectionB.title,
          description: `"${sectionB.title}" only present in second policy`,
          policyA: null,
          policyB: { id: policyB.id, content: this.truncate(sectionB.content, 200) },
          significance: 'medium',
        });
      }
    }

    // Generate summary using AI
    const summary = await this.generateComparisonSummary(policyA, policyB, similarities, differences);

    // Generate recommendation
    const recommendation = this.generatePairRecommendation(similarities, differences);

    return {
      summary,
      similarities,
      differences,
      recommendation,
    };
  }

  /**
   * Analyze regulatory coverage across policies
   */
  analyzeCoverage(policies: PolicyWithDetails[]): CoverageAnalysis {
    // Collect all regulatory areas
    const allAreas = new Set<RegulatoryArea>();
    policies.forEach(p => p.regulatoryAreas.forEach(a => allAreas.add(a)));

    const coveredAreas: RegulatoryArea[] = [];
    const missingAreas: RegulatoryArea[] = [];
    const gaps: CoverageGap[] = [];

    // Define commonly required areas for fintech
    const commonlyRequiredAreas: RegulatoryArea[] = [
      'DATA_PROTECTION',
      'AML_CFT',
      'CONSUMER_PROTECTION',
      'CYBERSECURITY',
    ];

    // Check coverage
    for (const area of commonlyRequiredAreas) {
      const policiesCoveringArea = policies.filter(p =>
        p.regulatoryAreas.includes(area)
      );

      if (policiesCoveringArea.length > 0) {
        coveredAreas.push(area);
      } else {
        missingAreas.push(area);
        gaps.push({
          area,
          description: `No policy covers ${getRegulatoryAreaName(area)}`,
          importance: this.getAreaImportance(area),
          recommendation: `Create a policy addressing ${getRegulatoryAreaName(area)} requirements from ${getRegulatoryAuthority(area)}`,
        });
      }
    }

    // Add all covered areas from policies
    allAreas.forEach(area => {
      if (!coveredAreas.includes(area)) {
        coveredAreas.push(area);
      }
    });

    const coveragePercentage = Math.round(
      (coveredAreas.length / (coveredAreas.length + missingAreas.length)) * 100
    );

    return {
      totalAreas: coveredAreas.length + missingAreas.length,
      coveredAreas,
      missingAreas,
      coveragePercentage,
      gaps,
    };
  }

  /**
   * Analyze single policy coverage against required areas
   */
  analyzePolicyCoverage(
    policy: PolicyWithDetails,
    requiredAreas: RegulatoryArea[]
  ): CoverageAnalysis {
    const coveredAreas = policy.regulatoryAreas.filter(area =>
      requiredAreas.includes(area)
    );

    const missingAreas = requiredAreas.filter(
      area => !policy.regulatoryAreas.includes(area)
    );

    const gaps: CoverageGap[] = missingAreas.map(area => ({
      area,
      description: `Policy does not address ${getRegulatoryAreaName(area)}`,
      importance: this.getAreaImportance(area),
      recommendation: `Add a section covering ${getRegulatoryAreaName(area)} requirements`,
    }));

    return {
      totalAreas: requiredAreas.length,
      coveredAreas,
      missingAreas,
      coveragePercentage: Math.round((coveredAreas.length / requiredAreas.length) * 100),
      gaps,
    };
  }

  // ==========================================================================
  // PRIVATE METHODS
  // ==========================================================================

  /**
   * Create policy summary for comparison
   */
  private createPolicySummary(policy: PolicyWithDetails): PolicySummary {
    const sections = extractSections(policy.content);

    return {
      id: policy.id,
      title: policy.title,
      regulatoryAreas: policy.regulatoryAreas,
      sectionCount: sections.length,
      wordCount: countWords(policy.content),
      createdAt: policy.createdAt,
    };
  }

  /**
   * Find similarities between policies
   */
  private async findSimilarities(
    policies: PolicyWithDetails[]
  ): Promise<SimilarityItem[]> {
    const similarities: SimilarityItem[] = [];

    // Compare regulatory areas
    const areaCount = new Map<RegulatoryArea, string[]>();
    
    for (const policy of policies) {
      for (const area of policy.regulatoryAreas) {
        const existing = areaCount.get(area) || [];
        existing.push(policy.id);
        areaCount.set(area, existing);
      }
    }

    // Find areas covered by multiple policies
    for (const [area, policyIds] of areaCount) {
      if (policyIds.length > 1) {
        similarities.push({
          area: getRegulatoryAreaName(area),
          description: `${policyIds.length} policies address ${getRegulatoryAreaName(area)}`,
          policies: policyIds,
          matchPercentage: Math.round((policyIds.length / policies.length) * 100),
        });
      }
    }

    // Compare section titles across policies
    const sectionTitles = new Map<string, string[]>();
    
    for (const policy of policies) {
      const sections = extractSections(policy.content);
      for (const section of sections) {
        const normalizedTitle = section.title.toLowerCase().trim();
        const existing = sectionTitles.get(normalizedTitle) || [];
        if (!existing.includes(policy.id)) {
          existing.push(policy.id);
        }
        sectionTitles.set(normalizedTitle, existing);
      }
    }

    // Find common sections
    for (const [title, policyIds] of sectionTitles) {
      if (policyIds.length > 1) {
        similarities.push({
          area: title,
          description: `${policyIds.length} policies include a section on "${title}"`,
          policies: policyIds,
          matchPercentage: Math.round((policyIds.length / policies.length) * 100),
        });
      }
    }

    return similarities;
  }

  /**
   * Find differences between policies
   */
  private async findDifferences(
    policies: PolicyWithDetails[]
  ): Promise<DifferenceItem[]> {
    const differences: DifferenceItem[] = [];

    // Compare pairs of policies
    for (let i = 0; i < policies.length - 1; i++) {
      for (let j = i + 1; j < policies.length; j++) {
        const policyA = policies[i];
        const policyB = policies[j];

        // Find unique regulatory areas
        const uniqueToA = policyA.regulatoryAreas.filter(
          area => !policyB.regulatoryAreas.includes(area)
        );
        const uniqueToB = policyB.regulatoryAreas.filter(
          area => !policyA.regulatoryAreas.includes(area)
        );

        for (const area of uniqueToA) {
          differences.push({
            area: getRegulatoryAreaName(area),
            description: `Only "${policyA.title}" covers ${getRegulatoryAreaName(area)}`,
            policyA: { id: policyA.id, content: `Covers ${getRegulatoryAreaName(area)}` },
            policyB: null,
            significance: this.getAreaImportance(area) === 'critical' ? 'high' : 'medium',
          });
        }

        for (const area of uniqueToB) {
          differences.push({
            area: getRegulatoryAreaName(area),
            description: `Only "${policyB.title}" covers ${getRegulatoryAreaName(area)}`,
            policyA: null,
            policyB: { id: policyB.id, content: `Covers ${getRegulatoryAreaName(area)}` },
            significance: this.getAreaImportance(area) === 'critical' ? 'high' : 'medium',
          });
        }
      }
    }

    return differences;
  }

  /**
   * Generate recommendations based on comparison
   */
  private async generateRecommendations(
    policies: PolicyWithDetails[],
    similarities: SimilarityItem[],
    differences: DifferenceItem[],
    coverage: CoverageAnalysis
  ): Promise<string[]> {
    const recommendations: string[] = [];

    // Coverage recommendations
    if (coverage.coveragePercentage < 100) {
      recommendations.push(
        `Improve regulatory coverage: Currently at ${coverage.coveragePercentage}%. Consider addressing: ${coverage.missingAreas.map(getRegulatoryAreaName).join(', ')}`
      );
    }

    // High significance differences
    const highDiffs = differences.filter(d => d.significance === 'high');
    if (highDiffs.length > 0) {
      recommendations.push(
        `Review ${highDiffs.length} high-significance difference(s) to ensure consistency across policies`
      );
    }

    // Consolidation recommendation
    if (similarities.length > policies.length * 2) {
      recommendations.push(
        'Consider consolidating overlapping policies to reduce duplication and maintenance overhead'
      );
    }

    // Gap recommendations
    for (const gap of coverage.gaps.slice(0, 3)) {
      recommendations.push(gap.recommendation);
    }

    // Add AI-generated recommendations for complex cases
    if (policies.length >= 3 && differences.length > 5) {
      try {
        const aiRecommendation = await this.getAIRecommendation(
          policies,
          similarities,
          differences
        );
        if (aiRecommendation) {
          recommendations.push(aiRecommendation);
        }
      } catch (error) {
        logger.warn({
          type: 'ai_recommendation_failed',
          error: (error as Error).message,
        });
      }
    }

    return recommendations;
  }

  /**
   * Get AI-generated recommendation
   */
  private async getAIRecommendation(
    policies: PolicyWithDetails[],
    similarities: SimilarityItem[],
    differences: DifferenceItem[]
  ): Promise<string | null> {
    const prompt = `
Based on a comparison of ${policies.length} compliance policies:

SIMILARITIES:
${similarities.slice(0, 5).map(s => `- ${s.description}`).join('\n')}

KEY DIFFERENCES:
${differences.filter(d => d.significance === 'high').slice(0, 5).map(d => `- ${d.description}`).join('\n')}

Provide ONE specific, actionable recommendation to improve the overall compliance posture (max 100 words).
`;

    const response = await (aiService as any).complete({
      prompt,
      maxTokens: 150,
      temperature: 0.5,
    });

    return response.content.trim();
  }

  /**
   * Generate comparison summary
   */
  private async generateComparisonSummary(
    policyA: PolicyWithDetails,
    policyB: PolicyWithDetails,
    similarities: SimilarityItem[],
    differences: DifferenceItem[]
  ): Promise<string> {
    const similarityPct = Math.round(
      (similarities.length / (similarities.length + differences.length)) * 100
    );

    return `Comparison of "${policyA.title}" and "${policyB.title}": ${similarityPct}% similar content. Found ${similarities.length} common elements and ${differences.length} differences. ${differences.filter(d => d.significance === 'high').length} high-significance differences require attention.`;
  }

  /**
   * Generate recommendation for policy pair
   */
  private generatePairRecommendation(
    similarities: SimilarityItem[],
    differences: DifferenceItem[]
  ): string {
    const highDiffs = differences.filter(d => d.significance === 'high');

    if (highDiffs.length === 0 && similarities.length > differences.length) {
      return 'Policies are well-aligned. Consider consolidating into a single document.';
    }

    if (highDiffs.length > 3) {
      return 'Significant differences detected. Review and reconcile the differing approaches.';
    }

    return 'Moderate alignment. Review specific differences to ensure consistent compliance approach.';
  }

  /**
   * Calculate text similarity (simple Jaccard similarity)
   */
  private calculateSimilarity(textA: string, textB: string): number {
    const wordsA = new Set(textA.toLowerCase().split(/\s+/));
    const wordsB = new Set(textB.toLowerCase().split(/\s+/));

    const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);

    return intersection.size / union.size;
  }

  /**
   * Get importance level for regulatory area
   */
  private getAreaImportance(
    area: RegulatoryArea
  ): 'low' | 'medium' | 'high' | 'critical' {
    const criticalAreas: RegulatoryArea[] = ['DATA_PROTECTION', 'AML_CFT', 'CYBERSECURITY'];
    const highAreas: RegulatoryArea[] = ['CONSUMER_PROTECTION', 'DIGITAL_LENDING', 'PAYMENT_SERVICES'];
    const mediumAreas: RegulatoryArea[] = ['BANKING', 'INSURANCE', 'TAX_COMPLIANCE'];

    if (criticalAreas.includes(area)) return 'critical';
    if (highAreas.includes(area)) return 'high';
    if (mediumAreas.includes(area)) return 'medium';
    return 'low';
  }

  /**
   * Truncate text
   */
  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + '...';
  }
}

// Export singleton
export const policyComparator = new PolicyComparator();
