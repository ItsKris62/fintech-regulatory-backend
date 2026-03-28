/**
 * Compliance Analyzer
 * Handles gap analysis, requirement analysis, and compliance roadmap generation
 */

import { prisma } from '@/lib/prisma/client';
import { complete } from '@/lib/ai/client';
import { logger } from '@/utils/logger';
import {
  type ComplianceGap,
  type ComplianceRoadmap,
  type RoadmapPhase,
  type RoadmapState,
  type RegulatoryArea,
  type GapSeverity,
  type GapPriority,
  type EffortEstimate,
  type CostRange,
  REGULATORY_AREA_NAMES,
} from './compliance.types';
import { getSeverityFromPriority } from './compliance.utils';
import { complianceScorer } from './compliance-scorer';

/**
 * Compliance Analyzer Class
 * Handles analysis and roadmap generation
 */
class ComplianceAnalyzer {
  /**
   * Identify compliance gaps for an organization
   */
  async identifyGaps(
    orgId: string,
    requiredAreas?: RegulatoryArea[]
  ): Promise<ComplianceGap[]> {
    logger.info({
      type: 'compliance_identify_gaps_started',
      orgId,
      requiredAreas,
    });

    try {
      // Get organization details
      const organization = await (prisma as any).organization.findUnique({ where: { id: orgId }, select: { id: true, type: true, settings: true } });

      if (!organization) {
        throw new Error('Organization not found');
      }

      // Determine which areas to analyze
      const settings = organization.settings as any;
      const areasToAnalyze = requiredAreas ||
        settings?.compliance?.regulatoryAreas ||
        this.getDefaultAreasForType(organization.type);

      // Get all requirements
      const requirements = await (prisma as any).requirement.findMany({
        where: {
          organizationId: orgId,
          regulatoryArea: { in: areasToAnalyze },
        },
      });

      // Group by area
      const byArea = new Map<string, typeof requirements>();
      for (const req of requirements) {
        if (!byArea.has(req.regulatoryArea)) {
          byArea.set(req.regulatoryArea, []);
        }
        byArea.get(req.regulatoryArea)!.push(req);
      }

      // Identify gaps (incomplete requirements)
      const gaps: ComplianceGap[] = [];

      for (const [area, reqs] of byArea.entries()) {
        const incompleteReqs = reqs.filter(
          (r: any) =>
            r.status !== 'COMPLETED' && r.status !== 'NOT_APPLICABLE'
        );

        for (const req of incompleteReqs) {
          const gap = this.createGapFromRequirement(
            req,
            area as RegulatoryArea
          );
          gaps.push(gap);
        }
      }

      // Check for missing areas (required but no requirements defined)
      for (const area of areasToAnalyze) {
        if (!byArea.has(area)) {
          gaps.push(this.createMissingAreaGap(area));
        }
      }

      // Sort by severity and priority
      gaps.sort((a, b) => {
        const severityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
        const priorityOrder = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
        
        const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
        if (sevDiff !== 0) return sevDiff;
        
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      });

      logger.info({
        type: 'compliance_identify_gaps_success',
        orgId,
        gapCount: gaps.length,
      });

      return gaps;
    } catch (error: any) {
      logger.error({
        type: 'compliance_identify_gaps_error',
        orgId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Analyze requirements for an organization
   */
  async analyzeRequirements(orgId: string): Promise<{
    total: number;
    completed: number;
    inProgress: number;
    notStarted: number;
    overdue: number;
    byArea: Record<RegulatoryArea, { total: number; completed: number }>;
    byPriority: Record<GapPriority, { total: number; completed: number }>;
    completionRate: number;
  }> {
    logger.info({
      type: 'compliance_analyze_requirements_started',
      orgId,
    });

    try {
      const requirements = await (prisma as any).requirement.findMany({
        where: { organizationId: orgId },
      });

      const now = new Date();
      const result = {
        total: requirements.length,
        completed: 0,
        inProgress: 0,
        notStarted: 0,
        overdue: 0,
        byArea: {} as Record<RegulatoryArea, { total: number; completed: number }>,
        byPriority: {} as Record<GapPriority, { total: number; completed: number }>,
        completionRate: 0,
      };

      for (const req of requirements) {
        // Count by status
        switch (req.status) {
          case 'COMPLETED':
            result.completed++;
            break;
          case 'IN_PROGRESS':
          case 'UNDER_REVIEW':
            result.inProgress++;
            break;
          case 'NOT_STARTED':
            result.notStarted++;
            break;
        }

        // Check for overdue
        if (
          req.dueDate &&
          req.dueDate < now &&
          req.status !== 'COMPLETED' &&
          req.status !== 'NOT_APPLICABLE'
        ) {
          result.overdue++;
        }

        // Count by area
        const area = req.regulatoryArea as RegulatoryArea;
        if (!result.byArea[area]) {
          result.byArea[area] = { total: 0, completed: 0 };
        }
        result.byArea[area].total++;
        if (req.status === 'COMPLETED') {
          result.byArea[area].completed++;
        }

        // Count by priority
        const priority = req.priority as GapPriority;
        if (!result.byPriority[priority]) {
          result.byPriority[priority] = { total: 0, completed: 0 };
        }
        result.byPriority[priority].total++;
        if (req.status === 'COMPLETED') {
          result.byPriority[priority].completed++;
        }
      }

      // Calculate completion rate
      if (result.total > 0) {
        result.completionRate = Math.round(
          (result.completed / result.total) * 100
        );
      }

      logger.info({
        type: 'compliance_analyze_requirements_success',
        orgId,
        total: result.total,
        completionRate: result.completionRate,
      });

      return result;
    } catch (error: any) {
      logger.error({
        type: 'compliance_analyze_requirements_error',
        orgId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Generate a compliance roadmap
   */
  async generateRoadmap(orgId: string): Promise<ComplianceRoadmap> {
    logger.info({
      type: 'compliance_generate_roadmap_started',
      orgId,
    });

    try {
      // Get current score
      const score = await complianceScorer.calculate(orgId);

      // Get gaps
      const gaps = await this.identifyGaps(orgId);

      // Current state
      const currentState: RoadmapState = {
        score: score.overallScore,
        grade: score.grade,
        compliantAreas: score.areaScores
          .filter((a) => a.status === 'COMPLIANT')
          .map((a) => a.area),
        nonCompliantAreas: score.areaScores
          .filter((a) => a.status !== 'COMPLIANT')
          .map((a) => a.area),
      };

      // Target state (90% score, Grade A)
      const targetState: RoadmapState = {
        score: 90,
        grade: 'A',
        compliantAreas: score.areaScores.map((a) => a.area),
        nonCompliantAreas: [],
      };

      // Generate phases
      const phases = this.generatePhases(gaps);

      // Calculate totals
      const totalDuration = this.calculateTotalDuration(phases);
      const totalEstimatedCost = this.calculateTotalCost(phases);

      // Identify critical path
      const criticalPath = gaps
        .filter((g) => g.severity === 'CRITICAL')
        .map((g) => (g as any).title);

      const roadmap: ComplianceRoadmap = {
        currentState,
        targetState,
        phases,
        totalDuration,
        totalEstimatedCost,
        criticalPath,
      };

      logger.info({
        type: 'compliance_generate_roadmap_success',
        orgId,
        phaseCount: phases.length,
        totalDuration,
      });

      return roadmap;
    } catch (error: any) {
      logger.error({
        type: 'compliance_generate_roadmap_error',
        orgId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Estimate time to compliance
   */
  async estimateTimeToCompliance(orgId: string): Promise<{
    estimatedDays: number;
    estimatedWeeks: number;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    factors: string[];
  }> {
    const gaps = await this.identifyGaps(orgId);
    
    let totalDays = 0;
    const factors: string[] = [];

    // Estimate based on gap severity
    const severityDays: Record<GapSeverity, number> = {
      CRITICAL: 21, // 3 weeks
      HIGH: 14, // 2 weeks
      MEDIUM: 7, // 1 week
      LOW: 3, // 3 days
    };

    for (const gap of gaps) {
      totalDays += severityDays[gap.severity];
    }

    // Add complexity factor
    if (gaps.length > 20) {
      totalDays *= 1.3;
      factors.push('High number of gaps adds coordination overhead');
    }

    // Check for critical gaps
    const criticalGaps = gaps.filter((g) => g.severity === 'CRITICAL');
    if (criticalGaps.length > 5) {
      totalDays *= 1.2;
      factors.push('Multiple critical gaps require prioritization');
    }

    // Confidence based on data quality
    let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH';
    if (gaps.length < 5) {
      confidence = 'LOW';
      factors.push('Limited data for accurate estimation');
    } else if (gaps.some((g) => !g.estimatedEffort)) {
      confidence = 'MEDIUM';
      factors.push('Some gaps lack effort estimates');
    }

    return {
      estimatedDays: Math.round(totalDays),
      estimatedWeeks: Math.ceil(totalDays / 7),
      confidence,
      factors,
    };
  }

  /**
   * Generate AI-powered gap recommendations
   */
  async generateGapRecommendations(gap: ComplianceGap): Promise<string[]> {
    try {
      const prompt = `
You are a Kenyan fintech regulatory compliance expert. 
Given this compliance gap, provide 3-5 specific, actionable recommendations:

Regulatory Area: ${gap.areaName}
Requirement: ${gap.requirement}
Description: ${gap.description}
Severity: ${gap.severity}
Priority: ${gap.priority}

Provide practical recommendations considering Kenyan regulatory context.
Format as a JSON array of strings.
`;

      const result = await complete({ prompt, maxTokens: 500 });

      try {
        return JSON.parse(result.content);
      } catch {
        // If not valid JSON, split by newlines
        return result.content
          .split('\n')
          .filter((line: string) => line.trim())
          .slice(0, 5);
      }
    } catch (error) {
      logger.warn({
        type: 'gap_recommendations_generation_failed',
        gapId: gap.id,
        error: (error as Error).message,
      });

      // Return default recommendations
      return [
        `Review ${gap.areaName} requirements and identify specific actions needed`,
        `Consult with regulatory experts familiar with ${gap.area} compliance`,
        `Document current state and create action plan with timeline`,
      ];
    }
  }

  // ==========================================================================
  // PRIVATE HELPER METHODS
  // ==========================================================================

  /**
   * Get default regulatory areas for organization type
   */
  private getDefaultAreasForType(orgType: string): RegulatoryArea[] {
    const typeAreas: Record<string, RegulatoryArea[]> = {
      FINTECH: ['CBK', 'DPA', 'AML', 'CFT', 'CONSUMER_PROTECTION', 'CYBERSECURITY', 'E_MONEY', 'PAYMENT_SYSTEMS'],
      BANK: ['CBK', 'DPA', 'AML', 'CFT', 'CONSUMER_PROTECTION', 'CYBERSECURITY', 'PAYMENT_SYSTEMS', 'CREDIT_REFERENCE'],
      INSURANCE: ['IRA', 'DPA', 'AML', 'CFT', 'CONSUMER_PROTECTION', 'CYBERSECURITY'],
      SACCO: ['SASRA', 'DPA', 'AML', 'CFT', 'CONSUMER_PROTECTION'],
      MFI: ['CBK', 'MICROFINANCE', 'DPA', 'AML', 'CFT', 'CONSUMER_PROTECTION'],
      PAYMENT_PROVIDER: ['CBK', 'E_MONEY', 'PAYMENT_SYSTEMS', 'DPA', 'AML', 'CFT', 'CYBERSECURITY'],
      LENDING: ['CBK', 'DIGITAL_LENDING', 'DPA', 'AML', 'CFT', 'CONSUMER_PROTECTION', 'CREDIT_REFERENCE'],
      INVESTMENT: ['CMA', 'DPA', 'AML', 'CFT', 'CONSUMER_PROTECTION', 'CYBERSECURITY'],
      REGULATOR: ['DPA', 'CYBERSECURITY'],
    };

    return typeAreas[orgType] || ['CBK', 'DPA', 'AML', 'CFT', 'CONSUMER_PROTECTION'];
  }

  /**
   * Create a compliance gap from a requirement
   */
  private createGapFromRequirement(
    req: {
      id: string;
      title: string;
      description: string;
      priority: string;
      dueDate: Date | null;
    },
    area: RegulatoryArea
  ): ComplianceGap {
    const priority = req.priority as GapPriority;
    const severity = getSeverityFromPriority(priority);

    return {
      id: req.id,
      area,
      areaName: REGULATORY_AREA_NAMES[area],
      requirement: req.title,
      description: req.description,
      severity,
      priority,
      estimatedEffort: this.estimateEffort(severity),
      recommendation: `Complete the "${req.title}" requirement for ${REGULATORY_AREA_NAMES[area]} compliance.`,
      resources: this.getResourcesForArea(area),
      deadline: req.dueDate || undefined,
    };
  }

  /**
   * Create a gap for missing regulatory area
   */
  private createMissingAreaGap(area: RegulatoryArea): ComplianceGap {
    return {
      id: `missing-${area}`,
      area,
      areaName: REGULATORY_AREA_NAMES[area],
      requirement: `${REGULATORY_AREA_NAMES[area]} compliance requirements not defined`,
      description: `Your organization has not defined any compliance requirements for ${REGULATORY_AREA_NAMES[area]}. This is a significant gap that needs to be addressed.`,
      severity: 'HIGH',
      priority: 'HIGH',
      estimatedEffort: {
        timeframe: '2-4 weeks',
        complexity: 'HIGH',
        resourcesNeeded: ['Compliance Officer', 'Legal Counsel'],
      },
      recommendation: `Define and document compliance requirements for ${REGULATORY_AREA_NAMES[area]}. Consider engaging a regulatory consultant.`,
      resources: this.getResourcesForArea(area),
    };
  }

  /**
   * Estimate effort for a gap
   */
  private estimateEffort(severity: GapSeverity): EffortEstimate {
    const efforts: Record<GapSeverity, EffortEstimate> = {
      CRITICAL: {
        timeframe: '1-2 weeks',
        complexity: 'HIGH',
        resourcesNeeded: ['Compliance Officer', 'Legal Counsel', 'Technical Team'],
        estimatedCost: { min: 100000, max: 500000, currency: 'KES' },
      },
      HIGH: {
        timeframe: '1-2 weeks',
        complexity: 'MEDIUM',
        resourcesNeeded: ['Compliance Officer', 'Technical Team'],
        estimatedCost: { min: 50000, max: 200000, currency: 'KES' },
      },
      MEDIUM: {
        timeframe: '3-5 days',
        complexity: 'MEDIUM',
        resourcesNeeded: ['Compliance Officer'],
        estimatedCost: { min: 20000, max: 100000, currency: 'KES' },
      },
      LOW: {
        timeframe: '1-3 days',
        complexity: 'LOW',
        resourcesNeeded: ['Compliance Staff'],
        estimatedCost: { min: 5000, max: 30000, currency: 'KES' },
      },
    };

    return efforts[severity];
  }

  /**
   * Get resources for a regulatory area
   */
  private getResourcesForArea(area: RegulatoryArea): string[] {
    const resources: Record<RegulatoryArea, string[]> = {
      CBK: ['CBK Prudential Guidelines', 'Banking Act', 'CBK Circulars'],
      CMA: ['Capital Markets Act', 'CMA Regulations', 'CMA Guidelines'],
      IRA: ['Insurance Act', 'IRA Guidelines', 'IRA Circulars'],
      SASRA: ['SACCO Societies Act', 'SASRA Regulations'],
      DPA: ['Data Protection Act 2019', 'ODPC Guidelines', 'Data Protection Regulations'],
      AML: ['POCAMLA', 'AML Guidelines', 'CBK AML Circulars'],
      CFT: ['Prevention of Terrorism Act', 'CFT Guidelines'],
      CONSUMER_PROTECTION: ['Consumer Protection Act', 'Fair Trading Practices'],
      CYBERSECURITY: ['Computer Misuse and Cybercrimes Act', 'CBK Cybersecurity Guidelines'],
      E_MONEY: ['National Payment System Regulations', 'E-Money Guidelines'],
      PAYMENT_SYSTEMS: ['National Payment Systems Act', 'Payment Systems Regulations'],
      CREDIT_REFERENCE: ['Credit Reference Bureau Regulations', 'CRB Guidelines'],
      MICROFINANCE: ['Microfinance Act', 'MFI Regulations'],
      DIGITAL_LENDING: ['Digital Credit Providers Regulations', 'CBK Digital Lending Guidelines'],
    };

    return resources[area] || [];
  }

  /**
   * Generate phases from gaps
   */
  private generatePhases(gaps: ComplianceGap[]): RoadmapPhase[] {
    const phases: RoadmapPhase[] = [];

    // Phase 1: Critical items (immediate)
    const critical = gaps.filter((g) => g.severity === 'CRITICAL');
    if (critical.length > 0) {
      phases.push({
        phase: 1,
        name: 'Critical Remediation',
        duration: '2-4 weeks',
        objectives: ['Address all critical compliance gaps', 'Reduce regulatory risk exposure'],
        requirements: critical.map((g) => g.requirement),
        deliverables: critical.map((g) => `${g.requirement} - completed and documented`),
        estimatedCost: this.sumCosts(critical),
      });
    }

    // Phase 2: High priority items
    const high = gaps.filter((g) => g.severity === 'HIGH');
    if (high.length > 0) {
      phases.push({
        phase: phases.length + 1,
        name: 'High Priority Compliance',
        duration: '4-6 weeks',
        objectives: ['Address high priority compliance gaps', 'Establish compliance framework'],
        requirements: high.map((g) => g.requirement),
        deliverables: high.map((g) => `${g.requirement} - completed and documented`),
        estimatedCost: this.sumCosts(high),
      });
    }

    // Phase 3: Medium and low priority
    const remaining = gaps.filter((g) => g.severity === 'MEDIUM' || g.severity === 'LOW');
    if (remaining.length > 0) {
      phases.push({
        phase: phases.length + 1,
        name: 'Continuous Improvement',
        duration: '6-12 weeks',
        objectives: ['Complete all remaining requirements', 'Achieve full compliance'],
        requirements: remaining.map((g) => g.requirement),
        deliverables: remaining.map((g) => `${g.requirement} - completed and documented`),
        estimatedCost: this.sumCosts(remaining),
      });
    }

    return phases;
  }

  /**
   * Sum costs from multiple gaps
   */
  private sumCosts(gaps: ComplianceGap[]): CostRange {
    let min = 0;
    let max = 0;

    for (const gap of gaps) {
      if (gap.estimatedEffort?.estimatedCost) {
        min += gap.estimatedEffort.estimatedCost.min;
        max += gap.estimatedEffort.estimatedCost.max;
      }
    }

    return { min, max, currency: 'KES' };
  }

  /**
   * Calculate total duration from phases
   */
  private calculateTotalDuration(phases: RoadmapPhase[]): string {
    if (phases.length === 0) return '0 weeks';
    
    let minWeeks = 0;
    let maxWeeks = 0;

    for (const phase of phases) {
      // Parse duration like "2-4 weeks"
      const match = phase.duration.match(/(\d+)-(\d+)/);
      if (match) {
        minWeeks += parseInt(match[1], 10);
        maxWeeks += parseInt(match[2], 10);
      }
    }

    return `${minWeeks}-${maxWeeks} weeks`;
  }

  /**
   * Calculate total cost from phases
   */
  private calculateTotalCost(phases: RoadmapPhase[]): CostRange {
    let min = 0;
    let max = 0;

    for (const phase of phases) {
      min += phase.estimatedCost.min;
      max += phase.estimatedCost.max;
    }

    return { min, max, currency: 'KES' };
  }
}

// Export singleton instance
export const complianceAnalyzer = new ComplianceAnalyzer();

// Export class for testing
export { ComplianceAnalyzer };
