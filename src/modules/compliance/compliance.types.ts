/**
 * Compliance Module Types
 * Type definitions for compliance queries, scoring, tracking, and risk assessment
 */

// ============================================================================
// Regulatory Areas (Kenya-specific)
// ============================================================================

/**
 * Regulatory areas for Kenya fintech compliance
 */
export type RegulatoryArea =
  | 'CBK' // Central Bank of Kenya
  | 'CMA' // Capital Markets Authority
  | 'IRA' // Insurance Regulatory Authority
  | 'SASRA' // SACCO Societies Regulatory Authority
  | 'DPA' // Data Protection Act
  | 'AML' // Anti-Money Laundering
  | 'CFT' // Counter-Financing of Terrorism
  | 'CONSUMER_PROTECTION'
  | 'CYBERSECURITY'
  | 'E_MONEY'
  | 'PAYMENT_SYSTEMS'
  | 'CREDIT_REFERENCE'
  | 'MICROFINANCE'
  | 'DIGITAL_LENDING';

/**
 * Regulatory area display names
 */
export const REGULATORY_AREA_NAMES: Record<RegulatoryArea, string> = {
  CBK: 'Central Bank of Kenya Regulations',
  CMA: 'Capital Markets Authority',
  IRA: 'Insurance Regulatory Authority',
  SASRA: 'SACCO Societies Regulatory Authority',
  DPA: 'Data Protection Act 2019',
  AML: 'Anti-Money Laundering',
  CFT: 'Counter-Financing of Terrorism',
  CONSUMER_PROTECTION: 'Consumer Protection',
  CYBERSECURITY: 'Cybersecurity Guidelines',
  E_MONEY: 'E-Money Regulations',
  PAYMENT_SYSTEMS: 'National Payment Systems',
  CREDIT_REFERENCE: 'Credit Reference Bureau',
  MICROFINANCE: 'Microfinance Act',
  DIGITAL_LENDING: 'Digital Credit Providers',
};

// ============================================================================
// Query Types
// ============================================================================

/**
 * Compliance query parameters
 */
export interface ComplianceQueryParams {
  query: string;
  regulatoryAreas?: RegulatoryArea[];
  context?: string;
  organizationId?: string;
  includeRecommendations?: boolean;
}

/**
 * Compliance query result
 */
export interface ComplianceQueryResult {
  id: string;
  query: string;
  answer: string;
  citations: QueryCitation[];
  regulatoryAreas: RegulatoryArea[];
  confidence: number; // 0-1
  recommendations?: string[];
  relatedQueries?: string[];
  processingTimeMs: number;
  createdAt: Date;
}

/**
 * Citation from regulatory source
 */
export interface QueryCitation {
  id: string;
  source: string;
  title: string;
  section: string;
  content: string;
  url?: string;
  relevanceScore: number;
  regulatoryArea: RegulatoryArea;
}

/**
 * Quick check result (simplified compliance check)
 */
export interface QuickCheckResult {
  isCompliant: boolean;
  riskLevel: RiskLevel;
  summary: string;
  keyPoints: string[];
  areasOfConcern: string[];
  nextSteps: string[];
}

/**
 * Query filters
 */
export interface QueryFilters {
  regulatoryArea?: RegulatoryArea;
  startDate?: Date;
  endDate?: Date;
  searchTerm?: string;
  page?: number;
  limit?: number;
}

/**
 * Paginated queries result
 */
export interface PaginatedQueries {
  queries: ComplianceQueryResult[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasMore: boolean;
}

// ============================================================================
// Compliance Score Types
// ============================================================================

/**
 * Overall compliance score
 */
export interface ComplianceScore {
  overallScore: number; // 0-100
  grade: ComplianceGrade;
  areaScores: AreaScore[];
  trend: ComplianceTrend;
  lastUpdated: Date;
  nextReviewDate: Date;
}

/**
 * Compliance grade
 */
export type ComplianceGrade = 'A' | 'B' | 'C' | 'D' | 'F';

/**
 * Score by regulatory area
 */
export interface AreaScore {
  area: RegulatoryArea;
  areaName: string;
  score: number;
  weight: number;
  completedRequirements: number;
  totalRequirements: number;
  status: AreaStatus;
}

/**
 * Area compliance status
 */
export type AreaStatus = 'COMPLIANT' | 'PARTIALLY_COMPLIANT' | 'NON_COMPLIANT' | 'NOT_APPLICABLE';

/**
 * Compliance trend
 */
export interface ComplianceTrend {
  direction: 'IMPROVING' | 'STABLE' | 'DECLINING';
  changePercent: number;
  periodDays: number;
  previousScore: number;
}

/**
 * Score history entry
 */
export interface ScoreHistory {
  date: Date;
  score: number;
  grade: ComplianceGrade;
  areaScores: Record<RegulatoryArea, number>;
}

// ============================================================================
// Gap Analysis Types
// ============================================================================

/**
 * Compliance gap
 */
export interface ComplianceGap {
  id: string;
  area: RegulatoryArea;
  areaName: string;
  requirement: string;
  description: string;
  severity: GapSeverity;
  priority: GapPriority;
  estimatedEffort: EffortEstimate;
  recommendation: string;
  resources?: string[];
  deadline?: Date;
}

/**
 * Gap severity
 */
export type GapSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * Gap priority
 */
export type GapPriority = 'URGENT' | 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * Effort estimate
 */
export interface EffortEstimate {
  timeframe: string; // e.g., "1-2 weeks"
  complexity: 'LOW' | 'MEDIUM' | 'HIGH';
  resourcesNeeded: string[];
  estimatedCost?: CostRange;
}

/**
 * Cost range
 */
export interface CostRange {
  min: number;
  max: number;
  currency: string;
}

/**
 * Compliance roadmap
 */
export interface ComplianceRoadmap {
  currentState: RoadmapState;
  targetState: RoadmapState;
  phases: RoadmapPhase[];
  totalDuration: string;
  totalEstimatedCost: CostRange;
  criticalPath: string[];
}

/**
 * Roadmap state
 */
export interface RoadmapState {
  score: number;
  grade: ComplianceGrade;
  compliantAreas: RegulatoryArea[];
  nonCompliantAreas: RegulatoryArea[];
}

/**
 * Roadmap phase
 */
export interface RoadmapPhase {
  phase: number;
  name: string;
  duration: string;
  startDate?: Date;
  endDate?: Date;
  objectives: string[];
  requirements: string[];
  deliverables: string[];
  estimatedCost: CostRange;
}

// ============================================================================
// Requirement Types
// ============================================================================

/**
 * Compliance requirement
 */
export interface Requirement {
  id: string;
  organizationId: string;
  area: RegulatoryArea;
  title: string;
  description: string;
  status: RequirementStatus;
  priority: GapPriority;
  dueDate: Date | null;
  completedAt: Date | null;
  assignedTo: string | null;
  evidence: Evidence[];
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Requirement status
 */
export type RequirementStatus =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'UNDER_REVIEW'
  | 'COMPLETED'
  | 'OVERDUE'
  | 'NOT_APPLICABLE';

/**
 * Requirement input params
 */
export interface RequirementParams {
  area: RegulatoryArea;
  title: string;
  description: string;
  priority?: GapPriority;
  dueDate?: Date;
  assignedTo?: string;
  notes?: string;
}

/**
 * Requirement filters
 */
export interface RequirementFilters {
  area?: RegulatoryArea;
  status?: RequirementStatus;
  priority?: GapPriority;
  assignedTo?: string;
  overdue?: boolean;
  page?: number;
  limit?: number;
}

/**
 * Evidence for requirement completion
 */
export interface Evidence {
  id: string;
  type: EvidenceType;
  title: string;
  description: string;
  documentId?: string;
  url?: string;
  uploadedBy: string;
  uploadedAt: Date;
}

/**
 * Evidence type
 */
export type EvidenceType =
  | 'DOCUMENT'
  | 'POLICY'
  | 'CERTIFICATE'
  | 'AUDIT_REPORT'
  | 'SCREENSHOT'
  | 'EXTERNAL_LINK'
  | 'OTHER';

/**
 * Upcoming deadline
 */
export interface UpcomingDeadline {
  requirementId: string;
  title: string;
  area: RegulatoryArea;
  dueDate: Date;
  daysRemaining: number;
  status: RequirementStatus;
  priority: GapPriority;
  assignedTo: string | null;
}

// ============================================================================
// Risk Assessment Types
// ============================================================================

/**
 * Risk level
 */
export type RiskLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'MINIMAL';

/**
 * Risk scenario for assessment
 */
export interface RiskScenario {
  title: string;
  description: string;
  regulatoryAreas: RegulatoryArea[];
  businessContext?: string;
  proposedActions?: string[];
}

/**
 * Risk assessment result
 */
export interface RiskAssessment {
  id: string;
  scenario: RiskScenario;
  overallRisk: RiskLevel;
  riskScore: number; // 0-100
  risks: IdentifiedRisk[];
  mitigationStrategies: MitigationStrategy[];
  recommendations: string[];
  requiresApproval: boolean;
  assessedAt: Date;
  assessedBy: string;
}

/**
 * Identified risk
 */
export interface IdentifiedRisk {
  id: string;
  title: string;
  description: string;
  area: RegulatoryArea;
  level: RiskLevel;
  likelihood: 'CERTAIN' | 'LIKELY' | 'POSSIBLE' | 'UNLIKELY' | 'RARE';
  impact: 'CATASTROPHIC' | 'MAJOR' | 'MODERATE' | 'MINOR' | 'INSIGNIFICANT';
  potentialConsequences: string[];
}

/**
 * Mitigation strategy
 */
export interface MitigationStrategy {
  riskId: string;
  strategy: string;
  actions: string[];
  timeline: string;
  resourcesRequired: string[];
  effectiveness: 'HIGH' | 'MEDIUM' | 'LOW';
}

/**
 * Risk report
 */
export interface RiskReport {
  organizationId: string;
  generatedAt: Date;
  period: {
    start: Date;
    end: Date;
  };
  summary: RiskSummary;
  assessments: RiskAssessment[];
  trendAnalysis: RiskTrendAnalysis;
  recommendations: string[];
  downloadUrl?: string;
}

/**
 * Risk summary
 */
export interface RiskSummary {
  totalRisks: number;
  byLevel: Record<RiskLevel, number>;
  byArea: Record<RegulatoryArea, number>;
  mitigatedCount: number;
  openCount: number;
}

/**
 * Risk trend analysis
 */
export interface RiskTrendAnalysis {
  trend: 'IMPROVING' | 'STABLE' | 'WORSENING';
  newRisks: number;
  resolvedRisks: number;
  escalatedRisks: number;
}

// ============================================================================
// Regulatory Updates Types
// ============================================================================

/**
 * Regulatory update
 */
export interface RegulatoryUpdate {
  id: string;
  area: RegulatoryArea;
  title: string;
  summary: string;
  content: string;
  source: string;
  sourceUrl?: string;
  effectiveDate: Date;
  publishedAt: Date;
  impact: UpdateImpact;
  actionRequired: boolean;
  actions?: string[];
}

/**
 * Update impact level
 */
export type UpdateImpact = 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * Update subscription
 */
export interface UpdateSubscription {
  id: string;
  userId: string;
  areas: RegulatoryArea[];
  frequency: 'IMMEDIATE' | 'DAILY' | 'WEEKLY';
  emailEnabled: boolean;
  inAppEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Error Types
// ============================================================================

export class ComplianceError extends Error {
  constructor(
    message: string,
    public code: ComplianceErrorCode,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = 'ComplianceError';
  }
}

export type ComplianceErrorCode =
  | 'QUERY_FAILED'
  | 'QUERY_NOT_FOUND'
  | 'RATE_LIMIT_EXCEEDED'
  | 'INVALID_AREA'
  | 'REQUIREMENT_NOT_FOUND'
  | 'SCORE_CALCULATION_FAILED'
  | 'RISK_ASSESSMENT_FAILED'
  | 'UNAUTHORIZED'
  | 'ORGANIZATION_NOT_FOUND'
  | 'EXPORT_FAILED';

// ============================================================================
// Constants
// ============================================================================

export const COMPLIANCE_CONSTANTS = {
  // Rate limits
  MAX_QUERIES_PER_HOUR: 50,
  MAX_QUICK_CHECKS_PER_HOUR: 100,
  
  // Cache TTL (in seconds)
  QUERY_CACHE_TTL: 24 * 60 * 60, // 24 hours
  SCORE_CACHE_TTL: 60 * 60, // 1 hour
  REQUIREMENTS_CACHE_TTL: 5 * 60, // 5 minutes
  
  // Score thresholds
  GRADE_THRESHOLDS: {
    A: 90,
    B: 80,
    C: 70,
    D: 60,
    F: 0,
  } as const,
  
  // Deadline reminder days
  REMINDER_DAYS: [30, 14, 7, 3, 1] as const,
  
  // Risk thresholds
  RISK_THRESHOLDS: {
    CRITICAL: 90,
    HIGH: 70,
    MEDIUM: 50,
    LOW: 30,
    MINIMAL: 0,
  } as const,
  
  // Certificate validity
  CERTIFICATE_VALIDITY_DAYS: 90,
  
  // Redis keys
  REDIS_KEYS: {
    QUERY_RATE: 'compliance:query_rate:',
    QUICK_CHECK_RATE: 'compliance:quick_check_rate:',
    SCORE: 'compliance:score:',
    REQUIREMENTS: 'compliance:requirements:',
    DEADLINES: 'compliance:deadlines:',
    SUBSCRIPTION: 'compliance:subscription:',
  },
  
  // Pagination defaults
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
} as const;

/**
 * Get grade from score
 */
export function getGradeFromScore(score: number): ComplianceGrade {
  const { GRADE_THRESHOLDS } = COMPLIANCE_CONSTANTS;
  if (score >= GRADE_THRESHOLDS.A) return 'A';
  if (score >= GRADE_THRESHOLDS.B) return 'B';
  if (score >= GRADE_THRESHOLDS.C) return 'C';
  if (score >= GRADE_THRESHOLDS.D) return 'D';
  return 'F';
}

/**
 * Get risk level from score
 */
export function getRiskLevelFromScore(score: number): RiskLevel {
  const { RISK_THRESHOLDS } = COMPLIANCE_CONSTANTS;
  if (score >= RISK_THRESHOLDS.CRITICAL) return 'CRITICAL';
  if (score >= RISK_THRESHOLDS.HIGH) return 'HIGH';
  if (score >= RISK_THRESHOLDS.MEDIUM) return 'MEDIUM';
  if (score >= RISK_THRESHOLDS.LOW) return 'LOW';
  return 'MINIMAL';
}
