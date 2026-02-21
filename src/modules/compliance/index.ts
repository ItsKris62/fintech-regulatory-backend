/**
 * Compliance Module - Public API
 * Export all compliance-related functionality
 */

// Main module
export { complianceModule, ComplianceModule } from './compliance.module';

// Sub-modules
export { complianceScorer, ComplianceScorer } from './compliance-scorer';
export { complianceAnalyzer, ComplianceAnalyzer } from './compliance-analyzer';
export { complianceTracker, ComplianceTracker } from './compliance-tracker';

// Types
export type {
  // Query types
  ComplianceQueryParams,
  ComplianceQueryResult,
  QueryCitation,
  QuickCheckResult,
  QueryFilters,
  PaginatedQueries,
  
  // Score types
  ComplianceScore,
  ComplianceGrade,
  AreaScore,
  AreaStatus,
  ComplianceTrend,
  ScoreHistory,
  
  // Gap types
  ComplianceGap,
  GapSeverity,
  GapPriority,
  EffortEstimate,
  CostRange,
  ComplianceRoadmap,
  RoadmapPhase,
  RoadmapState,
  
  // Requirement types
  Requirement,
  RequirementStatus,
  RequirementParams,
  RequirementFilters,
  Evidence,
  EvidenceType,
  UpcomingDeadline,
  
  // Risk types
  RiskLevel,
  RiskScenario,
  RiskAssessment,
  IdentifiedRisk,
  MitigationStrategy,
  RiskReport,
  RiskSummary,
  RiskTrendAnalysis,
  
  // Update types
  RegulatoryUpdate,
  UpdateImpact,
  UpdateSubscription,
  
  // Regulatory areas
  RegulatoryArea,
} from './compliance.types';

// Constants and utilities
export {
  COMPLIANCE_CONSTANTS,
  REGULATORY_AREA_NAMES,
  ComplianceError,
  getGradeFromScore,
  getRiskLevelFromScore,
} from './compliance.types';

export type { ComplianceErrorCode } from './compliance.types';

// Utilities (for use in other modules)
export {
  toComplianceQueryResult,
  toQueryCitation,
  toRequirement,
  toUpcomingDeadline,
  calculateWeightedScore,
  calculateTrend,
  calculateRiskScore,
  formatDaysRemaining,
  getPriorityColor,
  getRiskLevelColor,
  getGradeColor,
  complianceQuerySchema,
  quickCheckSchema,
  queryFiltersSchema,
  requirementParamsSchema,
  requirementStatusSchema,
  requirementFiltersSchema,
  evidenceParamsSchema,
  riskScenarioSchema,
  subscriptionSchema,
} from './compliance.utils';
