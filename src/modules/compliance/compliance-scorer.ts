/**
 * Compliance Scorer
 * Calculates compliance scores based on requirements and regulatory areas
 */

import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import {
  type ComplianceScore,
  type ComplianceGrade,
  type ComplianceTrend,
  type AreaScore,
  type AreaStatus,
  type ScoreHistory,
  type RegulatoryArea,
  COMPLIANCE_CONSTANTS,
  REGULATORY_AREA_NAMES,
  getGradeFromScore,
} from './compliance.types';
import {
  calculateWeightedScore,
  getAreaWeight,
  calculateTrend,
} from './compliance.utils';

const { REDIS_KEYS, SCORE_CACHE_TTL } = COMPLIANCE_CONSTANTS;

/**
 * Compliance Scorer Class
 * Handles all score calculation logic
 */
class ComplianceScorer {
  /**
   * Calculate overall compliance score for an organization
   */
  async calculate(orgId: string): Promise<ComplianceScore> {
    logger.info({
      type: 'compliance_score_calculate_started',
      orgId,
    });

    try {
      // Check cache first
      const cacheKey = `${REDIS_KEYS.SCORE}${orgId}`;
      const cached = await redis.get(cacheKey);
      
      if (cached) {
        logger.debug({ type: 'compliance_score_cache_hit', orgId });
        return JSON.parse(cached);
      }

      // Get organization with settings
      const organization = await (prisma as any).organization.findUnique({ where: { id: orgId }, select: { id: true, type: true, settings: true } });

      if (!organization) {
        throw new Error('Organization not found');
      }

      // Get all requirements for the organization
      const requirements = await (prisma as any).requirement.findMany({
        where: { organizationId: orgId },
      });

      // Calculate scores by area
      const areaScores = await this.calculateAreaScores(
        requirements,
        organization.type
      );

      // Calculate overall score
      const overallScore = calculateWeightedScore(
        areaScores.map((a) => ({ score: a.score, weight: a.weight }))
      );

      // Get grade
      const grade = getGradeFromScore(overallScore);

      // Calculate trend
      const trend = await this.calculateTrend(orgId);

      // Calculate next review date (30 days from now)
      const nextReviewDate = new Date();
      nextReviewDate.setDate(nextReviewDate.getDate() + 30);

      const score: ComplianceScore = {
        overallScore,
        grade,
        areaScores,
        trend,
        lastUpdated: new Date(),
        nextReviewDate,
      };

      // Cache the score
      await redis.setex(cacheKey, SCORE_CACHE_TTL, JSON.stringify(score));

      // Save score history
      await this.saveScoreHistory(orgId, score);

      logger.info({
        type: 'compliance_score_calculate_success',
        orgId,
        score: overallScore,
        grade,
      });

      return score;
    } catch (error: any) {
      logger.error({
        type: 'compliance_score_calculate_error',
        orgId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Calculate scores by regulatory area
   */
  private async calculateAreaScores(
    requirements: Array<{
      id: string;
      regulatoryArea: string;
      status: string;
      priority: string;
    }>,
    orgType: string
  ): Promise<AreaScore[]> {
    // Group requirements by area
    const byArea = new Map<string, typeof requirements>();
    
    for (const req of requirements) {
      const area = req.regulatoryArea;
      if (!byArea.has(area)) {
        byArea.set(area, []);
      }
      byArea.get(area)!.push(req);
    }

    // Calculate score for each area
    const areaScores: AreaScore[] = [];

    for (const [area, reqs] of byArea.entries()) {
      const score = this.calculateAreaScore(reqs);
      const weight = getAreaWeight(area as RegulatoryArea, orgType);
      const completedCount = reqs.filter(
        (r) => r.status === 'COMPLETED' || r.status === 'NOT_APPLICABLE'
      ).length;

      areaScores.push({
        area: area as RegulatoryArea,
        areaName: REGULATORY_AREA_NAMES[area as RegulatoryArea] || area,
        score,
        weight,
        completedRequirements: completedCount,
        totalRequirements: reqs.length,
        status: this.getAreaStatus(score),
      });
    }

    // Sort by weight (importance)
    return areaScores.sort((a, b) => b.weight - a.weight);
  }

  /**
   * Calculate score for a single area
   */
  private calculateAreaScore(
    requirements: Array<{ status: string; priority: string }>
  ): number {
    if (requirements.length === 0) return 100;

    // Weight by priority
    const priorityWeights: Record<string, number> = {
      URGENT: 4,
      HIGH: 3,
      MEDIUM: 2,
      LOW: 1,
    };

    let totalWeight = 0;
    let completedWeight = 0;

    for (const req of requirements) {
      const weight = priorityWeights[req.priority] || 2;
      totalWeight += weight;

      if (req.status === 'COMPLETED') {
        completedWeight += weight;
      } else if (req.status === 'NOT_APPLICABLE') {
        // Don't count N/A against score
        totalWeight -= weight;
      } else if (req.status === 'UNDER_REVIEW') {
        // Partial credit for under review
        completedWeight += weight * 0.75;
      } else if (req.status === 'IN_PROGRESS') {
        // Partial credit for in progress
        completedWeight += weight * 0.5;
      }
      // NOT_STARTED and OVERDUE get 0 credit
    }

    if (totalWeight === 0) return 100;
    return Math.round((completedWeight / totalWeight) * 100);
  }

  /**
   * Get area status based on score
   */
  private getAreaStatus(score: number): AreaStatus {
    if (score >= 90) return 'COMPLIANT';
    if (score >= 60) return 'PARTIALLY_COMPLIANT';
    return 'NON_COMPLIANT';
  }

  /**
   * Calculate score trend over time
   */
  async calculateTrend(
    orgId: string,
    periodDays: number = 30
  ): Promise<ComplianceTrend> {
    try {
      // Get historical scores
      const history = await this.getScoreHistory(orgId, periodDays);

      if (history.length < 2) {
        return {
          direction: 'STABLE',
          changePercent: 0,
          periodDays,
          previousScore: history[0]?.score || 0,
        };
      }

      const trend = calculateTrend(history, periodDays);

      return {
        direction: trend.direction,
        changePercent: trend.changePercent,
        periodDays,
        previousScore: history[history.length - 1].score,
      };
    } catch (error) {
      logger.warn({
        type: 'compliance_trend_calculation_error',
        orgId,
        error: (error as Error).message,
      });

      return {
        direction: 'STABLE',
        changePercent: 0,
        periodDays,
        previousScore: 0,
      };
    }
  }

  /**
   * Score a single regulatory area for an organization
   */
  async scoreByArea(orgId: string, area: RegulatoryArea): Promise<number> {
    logger.info({
      type: 'compliance_score_by_area_started',
      orgId,
      area,
    });

    try {
      const requirements = await (prisma as any).requirement.findMany({
        where: {
          organizationId: orgId,
          regulatoryArea: area,
        },
        select: {
          status: true,
          priority: true,
        },
      });

      const score = this.calculateAreaScore(requirements);

      logger.info({
        type: 'compliance_score_by_area_success',
        orgId,
        area,
        score,
      });

      return score;
    } catch (error: any) {
      logger.error({
        type: 'compliance_score_by_area_error',
        orgId,
        area,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Identify weak areas needing attention
   */
  async identifyWeakAreas(
    orgId: string
  ): Promise<Array<{ area: RegulatoryArea; score: number; gap: number }>> {
    const score = await this.calculate(orgId);
    
    return score.areaScores
      .filter((a) => a.score < 80) // Areas below 80%
      .map((a) => ({
        area: a.area,
        score: a.score,
        gap: 80 - a.score,
      }))
      .sort((a, b) => b.gap - a.gap);
  }

  /**
   * Generate improvement recommendations based on score
   */
  async generateRecommendations(orgId: string): Promise<string[]> {
    const score = await this.calculate(orgId);
    const recommendations: string[] = [];

    // General recommendations based on grade
    if (score.grade === 'F') {
      recommendations.push(
        'Your compliance score is critically low. Consider engaging a compliance consultant immediately.'
      );
    } else if (score.grade === 'D') {
      recommendations.push(
        'Your compliance score needs significant improvement. Prioritize urgent requirements.'
      );
    }

    // Area-specific recommendations
    for (const area of score.areaScores) {
      if (area.status === 'NON_COMPLIANT') {
        recommendations.push(
          `${area.areaName}: ${area.totalRequirements - area.completedRequirements} requirements pending. This area needs immediate attention.`
        );
      } else if (area.status === 'PARTIALLY_COMPLIANT') {
        recommendations.push(
          `${area.areaName}: Complete remaining ${area.totalRequirements - area.completedRequirements} requirements to achieve full compliance.`
        );
      }
    }

    // Trend-based recommendations
    if (score.trend.direction === 'DECLINING') {
      recommendations.push(
        `Your compliance score has declined by ${Math.abs(score.trend.changePercent)}% recently. Review recent changes and address any gaps.`
      );
    }

    return recommendations;
  }

  /**
   * Get score history for an organization
   */
  async getScoreHistory(
    orgId: string,
    days: number = 90
  ): Promise<ScoreHistory[]> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const history = await (prisma as any).complianceScoreHistory.findMany({
      where: {
        organizationId: orgId,
        createdAt: { gte: startDate },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        score: true,
        grade: true,
        areaScores: true,
        createdAt: true,
      },
    });

    return history.map((h: any) => ({
      date: h.createdAt,
      score: h.score,
      grade: h.grade as ComplianceGrade,
      areaScores: h.areaScores as Record<RegulatoryArea, number>,
    }));
  }

  /**
   * Save score to history
   */
  private async saveScoreHistory(
    orgId: string,
    score: ComplianceScore
  ): Promise<void> {
    try {
      // Convert area scores to record format
      const areaScoresRecord: Record<RegulatoryArea, number> = {} as any;
      for (const area of score.areaScores) {
        areaScoresRecord[area.area] = area.score;
      }

      await (prisma as any).complianceScoreHistory.create({
        data: {
          organizationId: orgId,
          score: score.overallScore,
          grade: score.grade,
          areaScores: areaScoresRecord,
        },
      });
    } catch (error) {
      // Log but don't throw - history is not critical
      logger.warn({
        type: 'compliance_score_history_save_error',
        orgId,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Invalidate cached score
   */
  async invalidateScore(orgId: string): Promise<void> {
    await redis.del(`${REDIS_KEYS.SCORE}${orgId}`);
  }
}

// Export singleton instance
export const complianceScorer = new ComplianceScorer();

// Export class for testing
export { ComplianceScorer };
