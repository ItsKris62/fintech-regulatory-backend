/**
 * Compliance Module Utilities
 * Validation schemas and helper functions for compliance operations
 */

import { z } from 'zod';
import type {
  ComplianceScore,
  ComplianceGrade,
  ComplianceQueryResult,
  QueryCitation,
  Requirement,
  UpcomingDeadline,
  RegulatoryArea,
  RequirementStatus,
  GapPriority,
  GapSeverity,
  RiskLevel,
} from './compliance.types';
import { REGULATORY_AREA_NAMES, getGradeFromScore as _getGradeFromScore } from './compliance.types';

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * Regulatory areas enum for validation
 */
const regulatoryAreaSchema = z.enum([
  'CBK',
  'CMA',
  'IRA',
  'SASRA',
  'DPA',
  'AML',
  'CFT',
  'CONSUMER_PROTECTION',
  'CYBERSECURITY',
  'E_MONEY',
  'PAYMENT_SYSTEMS',
  'CREDIT_REFERENCE',
  'MICROFINANCE',
  'DIGITAL_LENDING',
]);

/**
 * Compliance query validation schema
 */
export const complianceQuerySchema = z.object({
  query: z
    .string()
    .min(10, 'Query must be at least 10 characters')
    .max(2000, 'Query must be less than 2000 characters'),
  regulatoryAreas: z.array(regulatoryAreaSchema).optional(),
  context: z.string().max(5000).optional(),
  organizationId: z.string().uuid().optional(),
  includeRecommendations: z.boolean().optional().default(true),
});

/**
 * Quick check validation schema
 */
export const quickCheckSchema = z.object({
  scenario: z
    .string()
    .min(20, 'Scenario must be at least 20 characters')
    .max(5000, 'Scenario must be less than 5000 characters'),
  regulatoryAreas: z.array(regulatoryAreaSchema).optional(),
});

/**
 * Query filters validation schema
 */
export const queryFiltersSchema = z.object({
  regulatoryArea: regulatoryAreaSchema.optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  searchTerm: z.string().max(200).optional(),
  page: z.number().int().positive().default(1),
  limit: z.number().int().positive().max(100).default(20),
});

/**
 * Requirement params validation schema
 */
export const requirementParamsSchema = z.object({
  area: regulatoryAreaSchema,
  title: z.string().min(5).max(200),
  description: z.string().min(10).max(5000),
  priority: z.enum(['URGENT', 'HIGH', 'MEDIUM', 'LOW']).optional().default('MEDIUM'),
  dueDate: z.coerce.date().optional(),
  assignedTo: z.string().uuid().optional(),
  notes: z.string().max(2000).optional(),
});

/**
 * Requirement status update schema
 */
export const requirementStatusSchema = z.object({
  status: z.enum([
    'NOT_STARTED',
    'IN_PROGRESS',
    'UNDER_REVIEW',
    'COMPLETED',
    'OVERDUE',
    'NOT_APPLICABLE',
  ]),
  notes: z.string().max(2000).optional(),
});

/**
 * Requirement filters validation schema
 */
export const requirementFiltersSchema = z.object({
  area: regulatoryAreaSchema.optional(),
  status: z.enum([
    'NOT_STARTED',
    'IN_PROGRESS',
    'UNDER_REVIEW',
    'COMPLETED',
    'OVERDUE',
    'NOT_APPLICABLE',
  ]).optional(),
  priority: z.enum(['URGENT', 'HIGH', 'MEDIUM', 'LOW']).optional(),
  assignedTo: z.string().uuid().optional(),
  overdue: z.boolean().optional(),
  page: z.number().int().positive().default(1),
  limit: z.number().int().positive().max(100).default(20),
});

/**
 * Evidence params validation schema
 */
export const evidenceParamsSchema = z.object({
  type: z.enum([
    'DOCUMENT',
    'POLICY',
    'CERTIFICATE',
    'AUDIT_REPORT',
    'SCREENSHOT',
    'EXTERNAL_LINK',
    'OTHER',
  ]),
  title: z.string().min(3).max(200),
  description: z.string().max(1000).optional(),
  documentId: z.string().uuid().optional(),
  url: z.string().url().optional(),
});

/**
 * Risk scenario validation schema
 */
export const riskScenarioSchema = z.object({
  title: z.string().min(5).max(200),
  description: z.string().min(20).max(5000),
  regulatoryAreas: z.array(regulatoryAreaSchema).min(1),
  businessContext: z.string().max(2000).optional(),
  proposedActions: z.array(z.string()).optional(),
});

/**
 * Update subscription validation schema
 */
export const subscriptionSchema = z.object({
  areas: z.array(regulatoryAreaSchema).min(1),
  frequency: z.enum(['IMMEDIATE', 'DAILY', 'WEEKLY']).default('DAILY'),
  emailEnabled: z.boolean().default(true),
  inAppEnabled: z.boolean().default(true),
});

// ============================================================================
// Transformation Utilities
// ============================================================================

/**
 * Convert database query to ComplianceQueryResult
 */
export function toComplianceQueryResult(dbQuery: {
  id: string;
  query: string;
  response: string;
  citations?: any[];
  regulatoryAreas?: string[];
  confidence?: number;
  recommendations?: string[];
  processingTimeMs?: number;
  createdAt: Date;
}): ComplianceQueryResult {
  return {
    id: dbQuery.id,
    query: dbQuery.query,
    answer: dbQuery.response,
    citations: (dbQuery.citations || []).map(toQueryCitation),
    regulatoryAreas: (dbQuery.regulatoryAreas || []) as RegulatoryArea[],
    confidence: dbQuery.confidence || 0.8,
    recommendations: dbQuery.recommendations,
    processingTimeMs: dbQuery.processingTimeMs || 0,
    createdAt: dbQuery.createdAt,
  };
}

/**
 * Convert to QueryCitation
 */
export function toQueryCitation(citation: any): QueryCitation {
  return {
    id: citation.id || crypto.randomUUID(),
    source: citation.source || 'Unknown Source',
    title: citation.title || '',
    section: citation.section || '',
    content: citation.content || '',
    url: citation.url,
    relevanceScore: citation.relevanceScore || 0.8,
    regulatoryArea: citation.regulatoryArea || 'CBK',
  };
}

/**
 * Convert database requirement to Requirement
 */
export function toRequirement(dbReq: {
  id: string;
  organizationId: string;
  regulatoryArea: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  dueDate: Date | null;
  completedAt: Date | null;
  assignedTo: string | null;
  evidence?: any;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Requirement {
  return {
    id: dbReq.id,
    organizationId: dbReq.organizationId,
    area: dbReq.regulatoryArea as RegulatoryArea,
    title: dbReq.title,
    description: dbReq.description,
    status: dbReq.status as RequirementStatus,
    priority: dbReq.priority as GapPriority,
    dueDate: dbReq.dueDate,
    completedAt: dbReq.completedAt,
    assignedTo: dbReq.assignedTo,
    evidence: parseEvidence(dbReq.evidence),
    notes: dbReq.notes,
    createdAt: dbReq.createdAt,
    updatedAt: dbReq.updatedAt,
  };
}

/**
 * Parse evidence from JSON
 */
export function parseEvidence(evidence: any): any[] {
  if (!evidence) return [];
  if (Array.isArray(evidence)) return evidence;
  try {
    return JSON.parse(evidence);
  } catch {
    return [];
  }
}

/**
 * Convert to UpcomingDeadline
 */
export function toUpcomingDeadline(req: Requirement): UpcomingDeadline {
  const daysRemaining = req.dueDate
    ? Math.ceil((req.dueDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : 0;

  return {
    requirementId: req.id,
    title: req.title,
    area: req.area,
    dueDate: req.dueDate!,
    daysRemaining,
    status: req.status,
    priority: req.priority,
    assignedTo: req.assignedTo,
  };
}

// ============================================================================
// Score Utilities
// ============================================================================

/**
 * Calculate weighted average score
 */
export function calculateWeightedScore(
  scores: Array<{ score: number; weight: number }>
): number {
  if (scores.length === 0) return 0;
  
  const totalWeight = scores.reduce((sum, s) => sum + s.weight, 0);
  if (totalWeight === 0) return 0;
  
  const weightedSum = scores.reduce((sum, s) => sum + s.score * s.weight, 0);
  return Math.round(weightedSum / totalWeight);
}

/**
 * Get area weight based on organization type
 */
export function getAreaWeight(
  area: RegulatoryArea,
  orgType: string
): number {
  // Default weights
  const defaultWeights: Record<RegulatoryArea, number> = {
    CBK: 1.0,
    CMA: 0.8,
    IRA: 0.7,
    SASRA: 0.7,
    DPA: 1.0,
    AML: 1.0,
    CFT: 1.0,
    CONSUMER_PROTECTION: 0.9,
    CYBERSECURITY: 0.9,
    E_MONEY: 0.8,
    PAYMENT_SYSTEMS: 0.8,
    CREDIT_REFERENCE: 0.7,
    MICROFINANCE: 0.7,
    DIGITAL_LENDING: 0.8,
  };

  // Adjust weights based on organization type
  const typeMultipliers: Record<string, Partial<Record<RegulatoryArea, number>>> = {
    FINTECH: { E_MONEY: 1.2, PAYMENT_SYSTEMS: 1.2, DIGITAL_LENDING: 1.2 },
    BANK: { CBK: 1.2, AML: 1.2, CFT: 1.2 },
    INSURANCE: { IRA: 1.2, CONSUMER_PROTECTION: 1.1 },
    SACCO: { SASRA: 1.2, MICROFINANCE: 1.1 },
    MFI: { MICROFINANCE: 1.2, DIGITAL_LENDING: 1.1 },
    PAYMENT_PROVIDER: { E_MONEY: 1.2, PAYMENT_SYSTEMS: 1.2 },
    LENDING: { DIGITAL_LENDING: 1.2, CREDIT_REFERENCE: 1.1 },
  };

  const baseWeight = defaultWeights[area] || 0.5;
  const multiplier = typeMultipliers[orgType]?.[area] || 1.0;
  
  return baseWeight * multiplier;
}

/**
 * Calculate trend from score history
 */
export function calculateTrend(
  scores: Array<{ date: Date; score: number }>,
  _periodDays: number = 30
): { direction: 'IMPROVING' | 'STABLE' | 'DECLINING'; changePercent: number } {
  if (scores.length < 2) {
    return { direction: 'STABLE', changePercent: 0 };
  }

  const sorted = [...scores].sort((a, b) => b.date.getTime() - a.date.getTime());
  const latest = sorted[0].score;
  const previous = sorted[sorted.length - 1].score;
  
  const changePercent = previous > 0
    ? Math.round(((latest - previous) / previous) * 100)
    : 0;

  let direction: 'IMPROVING' | 'STABLE' | 'DECLINING' = 'STABLE';
  if (changePercent > 5) direction = 'IMPROVING';
  else if (changePercent < -5) direction = 'DECLINING';

  return { direction, changePercent };
}

// ============================================================================
// Risk Utilities
// ============================================================================

/**
 * Calculate risk score from likelihood and impact
 */
export function calculateRiskScore(
  likelihood: string,
  impact: string
): number {
  const likelihoodScores: Record<string, number> = {
    CERTAIN: 5,
    LIKELY: 4,
    POSSIBLE: 3,
    UNLIKELY: 2,
    RARE: 1,
  };

  const impactScores: Record<string, number> = {
    CATASTROPHIC: 5,
    MAJOR: 4,
    MODERATE: 3,
    MINOR: 2,
    INSIGNIFICANT: 1,
  };

  const l = likelihoodScores[likelihood] || 3;
  const i = impactScores[impact] || 3;
  
  return Math.round((l * i / 25) * 100);
}

/**
 * Get severity from gap priority
 */
export function getSeverityFromPriority(priority: GapPriority): GapSeverity {
  const mapping: Record<GapPriority, GapSeverity> = {
    URGENT: 'CRITICAL',
    HIGH: 'HIGH',
    MEDIUM: 'MEDIUM',
    LOW: 'LOW',
  };
  return mapping[priority];
}

// ============================================================================
// Email Templates
// ============================================================================

/**
 * Generate deadline reminder email
 */
export function generateDeadlineReminderEmail(
  userName: string,
  deadline: UpcomingDeadline
): { subject: string; text: string; html: string } {
  const areaName = REGULATORY_AREA_NAMES[deadline.area];
  const dueDateStr = deadline.dueDate.toLocaleDateString('en-KE', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const subject = `⏰ Compliance Deadline Reminder: ${deadline.title} (${deadline.daysRemaining} days remaining)`;

  const text = `
Hi ${userName},

This is a reminder about an upcoming compliance deadline:

Requirement: ${deadline.title}
Regulatory Area: ${areaName}
Due Date: ${dueDateStr}
Days Remaining: ${deadline.daysRemaining}
Priority: ${deadline.priority}

Please ensure this requirement is addressed before the deadline.

Best regards,
SheriaBot Compliance Team
`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #f97316; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
    .content { background: #f9fafb; padding: 20px; border-radius: 0 0 8px 8px; }
    .deadline-box { background: white; padding: 15px; border-radius: 8px; margin: 15px 0; border-left: 4px solid #f97316; }
    .days-badge { display: inline-block; background: #fef3c7; color: #92400e; padding: 4px 12px; border-radius: 20px; font-weight: bold; }
    .priority { font-weight: bold; }
    .priority-URGENT { color: #dc2626; }
    .priority-HIGH { color: #ea580c; }
    .priority-MEDIUM { color: #ca8a04; }
    .priority-LOW { color: #65a30d; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin:0;">⏰ Compliance Deadline Reminder</h1>
    </div>
    <div class="content">
      <p>Hi ${userName},</p>
      <p>This is a reminder about an upcoming compliance deadline:</p>
      
      <div class="deadline-box">
        <h3 style="margin-top:0;">${deadline.title}</h3>
        <p><strong>Regulatory Area:</strong> ${areaName}</p>
        <p><strong>Due Date:</strong> ${dueDateStr}</p>
        <p><span class="days-badge">${deadline.daysRemaining} days remaining</span></p>
        <p><strong>Priority:</strong> <span class="priority priority-${deadline.priority}">${deadline.priority}</span></p>
      </div>
      
      <p>Please ensure this requirement is addressed before the deadline.</p>
      
      <p>Best regards,<br>SheriaBot Compliance Team</p>
    </div>
  </div>
</body>
</html>
`;

  return { subject, text, html };
}

/**
 * Generate compliance score alert email
 */
export function generateScoreAlertEmail(
  userName: string,
  orgName: string,
  score: ComplianceScore,
  previousScore: number
): { subject: string; text: string; html: string } {
  const scoreDiff = score.overallScore - previousScore;
  const trend = scoreDiff > 0 ? 'improved' : scoreDiff < 0 ? 'declined' : 'remained stable';
  const emoji = scoreDiff > 0 ? '📈' : scoreDiff < 0 ? '📉' : '➡️';

  const subject = `${emoji} Compliance Score Update: ${orgName} - ${score.overallScore}/100 (${score.grade})`;

  const text = `
Hi ${userName},

Your organization's compliance score has ${trend}.

Current Score: ${score.overallScore}/100 (Grade: ${score.grade})
Previous Score: ${previousScore}/100
Change: ${scoreDiff > 0 ? '+' : ''}${scoreDiff} points

Trend: ${score.trend.direction}

Best regards,
SheriaBot Compliance Team
`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #2563eb; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
    .content { background: #f9fafb; padding: 20px; border-radius: 0 0 8px 8px; }
    .score-box { background: white; padding: 20px; border-radius: 8px; margin: 15px 0; text-align: center; }
    .score { font-size: 48px; font-weight: bold; color: #2563eb; }
    .grade { font-size: 24px; color: #64748b; }
    .change { font-size: 18px; margin-top: 10px; }
    .change.positive { color: #16a34a; }
    .change.negative { color: #dc2626; }
    .change.neutral { color: #64748b; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin:0;">${emoji} Compliance Score Update</h1>
    </div>
    <div class="content">
      <p>Hi ${userName},</p>
      <p>Your organization's compliance score has ${trend}.</p>
      
      <div class="score-box">
        <div class="score">${score.overallScore}</div>
        <div class="grade">Grade: ${score.grade}</div>
        <div class="change ${scoreDiff > 0 ? 'positive' : scoreDiff < 0 ? 'negative' : 'neutral'}">
          ${scoreDiff > 0 ? '↑' : scoreDiff < 0 ? '↓' : '→'} ${Math.abs(scoreDiff)} points from previous
        </div>
      </div>
      
      <p><strong>Trend:</strong> ${score.trend.direction}</p>
      
      <p>Best regards,<br>SheriaBot Compliance Team</p>
    </div>
  </div>
</body>
</html>
`;

  return { subject, text, html };
}

/**
 * Generate regulatory update notification email
 */
export function generateRegulatoryUpdateEmail(
  userName: string,
  update: {
    area: RegulatoryArea;
    title: string;
    summary: string;
    effectiveDate: Date;
    impact: string;
    actionRequired: boolean;
  }
): { subject: string; text: string; html: string } {
  const areaName = REGULATORY_AREA_NAMES[update.area];
  const effectiveDateStr = update.effectiveDate.toLocaleDateString('en-KE', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const impactEmoji = update.impact === 'HIGH' ? '🔴' : update.impact === 'MEDIUM' ? '🟡' : '🟢';
  const actionEmoji = update.actionRequired ? '⚠️' : 'ℹ️';

  const subject = `${actionEmoji} Regulatory Update: ${update.title} (${areaName})`;

  const text = `
Hi ${userName},

A new regulatory update has been published that may affect your organization:

Title: ${update.title}
Regulatory Area: ${areaName}
Effective Date: ${effectiveDateStr}
Impact Level: ${update.impact}
Action Required: ${update.actionRequired ? 'Yes' : 'No'}

Summary:
${update.summary}

Please review this update and take appropriate action if necessary.

Best regards,
SheriaBot Compliance Team
`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #7c3aed; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
    .content { background: #f9fafb; padding: 20px; border-radius: 0 0 8px 8px; }
    .update-box { background: white; padding: 15px; border-radius: 8px; margin: 15px 0; }
    .impact-badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-weight: bold; font-size: 12px; }
    .impact-HIGH { background: #fecaca; color: #b91c1c; }
    .impact-MEDIUM { background: #fef3c7; color: #92400e; }
    .impact-LOW { background: #d1fae5; color: #065f46; }
    .action-required { background: #fef3c7; border: 1px solid #f59e0b; padding: 10px; border-radius: 8px; margin-top: 15px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin:0;">${actionEmoji} Regulatory Update</h1>
    </div>
    <div class="content">
      <p>Hi ${userName},</p>
      <p>A new regulatory update has been published that may affect your organization:</p>
      
      <div class="update-box">
        <h3 style="margin-top:0;">${update.title}</h3>
        <p><strong>Regulatory Area:</strong> ${areaName}</p>
        <p><strong>Effective Date:</strong> ${effectiveDateStr}</p>
        <p><strong>Impact Level:</strong> <span class="impact-badge impact-${update.impact}">${impactEmoji} ${update.impact}</span></p>
        
        <h4>Summary</h4>
        <p>${update.summary}</p>
        
        ${update.actionRequired ? `
        <div class="action-required">
          <strong>⚠️ Action Required</strong>
          <p>This update requires action from your organization. Please review the details and ensure compliance.</p>
        </div>
        ` : ''}
      </div>
      
      <p>Best regards,<br>SheriaBot Compliance Team</p>
    </div>
  </div>
</body>
</html>
`;

  return { subject, text, html };
}

// ============================================================================
// Formatting Utilities
// ============================================================================

/**
 * Format days remaining with appropriate urgency
 */
export function formatDaysRemaining(days: number): string {
  if (days < 0) return `${Math.abs(days)} days overdue`;
  if (days === 0) return 'Due today';
  if (days === 1) return '1 day remaining';
  return `${days} days remaining`;
}

/**
 * Get priority color
 */
export function getPriorityColor(priority: GapPriority): string {
  const colors: Record<GapPriority, string> = {
    URGENT: '#dc2626',
    HIGH: '#ea580c',
    MEDIUM: '#ca8a04',
    LOW: '#65a30d',
  };
  return colors[priority];
}

/**
 * Get risk level color
 */
export function getRiskLevelColor(level: RiskLevel): string {
  const colors: Record<RiskLevel, string> = {
    CRITICAL: '#dc2626',
    HIGH: '#ea580c',
    MEDIUM: '#ca8a04',
    LOW: '#65a30d',
    MINIMAL: '#22c55e',
  };
  return colors[level];
}

/**
 * Get grade color
 */
export function getGradeColor(grade: ComplianceGrade): string {
  const colors: Record<ComplianceGrade, string> = {
    A: '#22c55e',
    B: '#65a30d',
    C: '#ca8a04',
    D: '#ea580c',
    F: '#dc2626',
  };
  return colors[grade];
}
