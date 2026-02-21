/**
 * Policy Module Utilities
 * Helper functions and validation schemas for policy operations
 */

import { z } from 'zod';
import type {
  Policy,
  PolicyWithDetails,
  Citation,
  PolicyVersion,
  PolicySection,
  RegulatoryArea,
  PolicyStatus,
  ExportFormat,
} from './policy.types';
import { POLICY_CONSTANTS } from './policy.types';

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * Regulatory areas enum for validation
 */
const regulatoryAreaEnum = z.enum([
  'DATA_PROTECTION',
  'AML_CFT',
  'CONSUMER_PROTECTION',
  'CYBERSECURITY',
  'DIGITAL_LENDING',
  'PAYMENT_SERVICES',
  'BANKING',
  'INSURANCE',
  'CAPITAL_MARKETS',
  'MICROFINANCE',
  'SACCO',
  'TAX_COMPLIANCE',
  'CORPORATE_GOVERNANCE',
  'EMPLOYMENT',
  'ENVIRONMENTAL',
  'OTHER',
]);

/**
 * Policy generation input validation
 */
export const policyGenerationSchema = z.object({
  scenario: z
    .string()
    .min(10, 'Scenario must be at least 10 characters')
    .max(
      POLICY_CONSTANTS.MAX_SCENARIO_LENGTH,
      `Scenario must be less than ${POLICY_CONSTANTS.MAX_SCENARIO_LENGTH} characters`
    ),
  organizationType: z
    .string()
    .min(2, 'Organization type is required')
    .max(50, 'Organization type too long'),
  regulatoryAreas: z
    .array(regulatoryAreaEnum)
    .min(1, 'At least one regulatory area is required')
    .max(10, 'Maximum 10 regulatory areas'),
  additionalContext: z
    .string()
    .max(POLICY_CONSTANTS.MAX_ADDITIONAL_CONTEXT_LENGTH)
    .optional(),
  includeRecommendations: z.boolean().default(true),
  detailLevel: z.enum(['brief', 'standard', 'comprehensive']).default('standard'),
  targetAudience: z.enum(['technical', 'executive', 'legal']).default('executive'),
});

/**
 * Policy update validation
 */
export const policyUpdateSchema = z.object({
  title: z
    .string()
    .min(5, 'Title must be at least 5 characters')
    .max(POLICY_CONSTANTS.MAX_TITLE_LENGTH)
    .optional(),
  description: z.string().max(500).optional().nullable(),
  content: z.string().max(POLICY_CONSTANTS.MAX_POLICY_SIZE_BYTES).optional(),
  regulatoryAreas: z.array(regulatoryAreaEnum).min(1).optional(),
});

/**
 * Policy refinement validation
 */
export const policyRefinementSchema = z.object({
  instructions: z
    .string()
    .min(10, 'Instructions must be at least 10 characters')
    .max(2000, 'Instructions too long'),
  focusAreas: z.array(z.string()).max(5).optional(),
  preserveSections: z.array(z.string()).optional(),
});

/**
 * Export options validation
 */
export const exportOptionsSchema = z.object({
  format: z.enum(['PDF', 'DOCX', 'JSON', 'MARKDOWN']),
  includeMetadata: z.boolean().default(true),
  includeCitations: z.boolean().default(true),
  includeVersionHistory: z.boolean().default(false),
  watermark: z.string().max(100).optional(),
  headerLogo: z.string().url().optional(),
  footerText: z.string().max(200).optional(),
});

/**
 * Policy filters validation
 */
export const policyFiltersSchema = z.object({
  status: z.enum(['DRAFT', 'GENERATING', 'COMPLETED', 'FAILED', 'PUBLISHED', 'ARCHIVED']).optional(),
  regulatoryAreas: z.array(regulatoryAreaEnum).optional(),
  organizationType: z.string().optional(),
  search: z.string().optional(),
  userId: z.string().uuid().optional(),
  organizationId: z.string().uuid().optional(),
  startDate: z.date().optional(),
  endDate: z.date().optional(),
  page: z.number().int().positive().default(1),
  limit: z.number().int().positive().max(100).default(20),
  sortBy: z.enum(['createdAt', 'updatedAt', 'title']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * Comment validation
 */
export const commentSchema = z.object({
  content: z
    .string()
    .min(1, 'Comment cannot be empty')
    .max(2000, 'Comment too long'),
  parentId: z.string().uuid().optional(),
});

// ============================================================================
// Data Transformation Utilities
// ============================================================================

/**
 * Convert database policy to Policy type
 */
export function toPolicy(dbPolicy: any): Policy {
  return {
    id: dbPolicy.id,
    title: dbPolicy.title,
    description: dbPolicy.description,
    content: dbPolicy.content || '',
    summary: dbPolicy.summary,
    status: dbPolicy.status as PolicyStatus,
    organizationType: dbPolicy.organizationType,
    regulatoryAreas: dbPolicy.regulatoryAreas as RegulatoryArea[],
    scenario: dbPolicy.scenario,
    userId: dbPolicy.userId,
    organizationId: dbPolicy.organizationId,
    aiModel: dbPolicy.aiModel,
    tokensUsed: dbPolicy.tokensUsed || 0,
    generationTime: dbPolicy.generationTime,
    version: dbPolicy.version || 1,
    parentVersionId: dbPolicy.parentVersionId,
    createdAt: dbPolicy.createdAt,
    updatedAt: dbPolicy.updatedAt,
    publishedAt: dbPolicy.publishedAt,
  };
}

/**
 * Convert database policy with relations to PolicyWithDetails
 */
export function toPolicyWithDetails(dbPolicy: any): PolicyWithDetails {
  return {
    ...toPolicy(dbPolicy),
    citations: (dbPolicy.citations || []).map(toCitation),
    user: dbPolicy.user ? {
      id: dbPolicy.user.id,
      name: dbPolicy.user.name,
      email: dbPolicy.user.email,
    } : { id: '', name: 'Unknown', email: '' },
    organization: dbPolicy.organization ? {
      id: dbPolicy.organization.id,
      name: dbPolicy.organization.name,
    } : null,
    versions: (dbPolicy.versions || []).map(toVersion),
    commentsCount: dbPolicy._count?.comments || 0,
  };
}

/**
 * Convert database citation to Citation type
 */
export function toCitation(dbCitation: any): Citation {
  return {
    id: dbCitation.id,
    policyId: dbCitation.policyId,
    source: dbCitation.source,
    title: dbCitation.title,
    section: dbCitation.section,
    content: dbCitation.content,
    url: dbCitation.url,
    confidence: dbCitation.confidence || 0,
    verified: dbCitation.verified || false,
    verifiedAt: dbCitation.verifiedAt,
    createdAt: dbCitation.createdAt,
  };
}

/**
 * Convert database version to PolicyVersion type
 */
export function toVersion(dbVersion: any): PolicyVersion {
  return {
    id: dbVersion.id,
    policyId: dbVersion.policyId,
    version: dbVersion.version,
    title: dbVersion.title,
    content: dbVersion.content,
    changeDescription: dbVersion.changeDescription,
    createdBy: dbVersion.createdBy,
    createdAt: dbVersion.createdAt,
  };
}

// ============================================================================
// Content Processing Utilities
// ============================================================================

/**
 * Extract sections from markdown content
 */
export function extractSections(content: string): PolicySection[] {
  const sections: PolicySection[] = [];
  const lines = content.split('\n');
  
  let currentSection: PolicySection | null = null;
  let sectionContent: string[] = [];
  let order = 0;
  
  for (const line of lines) {
    const h1Match = line.match(/^# (.+)$/);
    const h2Match = line.match(/^## (.+)$/);
    const h3Match = line.match(/^### (.+)$/);
    
    if (h1Match || h2Match || h3Match) {
      // Save previous section
      if (currentSection) {
        currentSection.content = sectionContent.join('\n').trim();
        sections.push(currentSection);
      }
      
      // Start new section
      order++;
      const level = h1Match ? 1 : h2Match ? 2 : 3;
      const title = (h1Match || h2Match || h3Match)![1];
      
      currentSection = {
        id: `section-${order}`,
        title,
        content: '',
        order,
        level,
      };
      sectionContent = [];
    } else if (currentSection) {
      sectionContent.push(line);
    }
  }
  
  // Save last section
  if (currentSection) {
    currentSection.content = sectionContent.join('\n').trim();
    sections.push(currentSection);
  }
  
  return sections;
}

/**
 * Count words in content
 */
export function countWords(content: string): number {
  return content
    .replace(/[#*`_\[\]()]/g, '') // Remove markdown syntax
    .split(/\s+/)
    .filter(word => word.length > 0)
    .length;
}

/**
 * Estimate reading time in minutes
 */
export function estimateReadingTime(content: string): number {
  const words = countWords(content);
  const wordsPerMinute = 200;
  return Math.ceil(words / wordsPerMinute);
}

/**
 * Generate policy title from scenario
 */
export function generateTitle(scenario: string, organizationType: string): string {
  // Extract key terms from scenario
  const words = scenario.split(' ').slice(0, 10);
  const keyTerms = words.filter(w => w.length > 3).slice(0, 5).join(' ');
  
  return `${organizationType} Policy: ${keyTerms}`;
}

/**
 * Truncate text with ellipsis
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

// ============================================================================
// Citation Utilities
// ============================================================================

/**
 * Extract citations from AI-generated content
 * Looks for patterns like [Source: ...] or (Source: ...)
 */
export function extractCitationsFromContent(content: string): Array<{
  source: string;
  title: string;
  section: string | null;
  content: string;
}> {
  const citations: Array<{
    source: string;
    title: string;
    section: string | null;
    content: string;
  }> = [];
  
  // Pattern: [Source: Source Name, Section X.X] "quoted content"
  const pattern = /\[(?:Source|Ref|Citation):\s*([^\],]+)(?:,\s*(?:Section|s\.)\s*([^\]]+))?\]\s*["""]([^"""]+)["""]/gi;
  
  let match;
  while ((match = pattern.exec(content)) !== null) {
    citations.push({
      source: match[1].trim(),
      title: match[1].trim(),
      section: match[2]?.trim() || null,
      content: match[3].trim(),
    });
  }
  
  // Also look for reference list at the end
  const refSection = content.match(/## References\s+([\s\S]*?)(?=##|$)/i);
  if (refSection) {
    const refLines = refSection[1].split('\n').filter(line => line.trim().startsWith('-') || line.trim().match(/^\d+\./));
    for (const line of refLines) {
      const cleanLine = line.replace(/^[-\d.)\s]+/, '').trim();
      if (cleanLine) {
        citations.push({
          source: cleanLine,
          title: cleanLine,
          section: null,
          content: '',
        });
      }
    }
  }
  
  return citations;
}

/**
 * Format citation for display
 */
export function formatCitation(citation: Citation): string {
  let formatted = citation.source;
  if (citation.section) {
    formatted += `, Section ${citation.section}`;
  }
  return formatted;
}

// ============================================================================
// Status Utilities
// ============================================================================

/**
 * Check if policy can be edited
 */
export function canEditPolicy(status: PolicyStatus): boolean {
  return ['DRAFT', 'COMPLETED'].includes(status);
}

/**
 * Check if policy can be published
 */
export function canPublishPolicy(status: PolicyStatus): boolean {
  return status === 'COMPLETED';
}

/**
 * Check if policy can be deleted
 */
export function canDeletePolicy(status: PolicyStatus): boolean {
  return ['DRAFT', 'COMPLETED', 'FAILED'].includes(status);
}

/**
 * Get status display info
 */
export function getStatusInfo(status: PolicyStatus): {
  label: string;
  color: string;
  description: string;
} {
  const statusInfo: Record<PolicyStatus, { label: string; color: string; description: string }> = {
    DRAFT: {
      label: 'Draft',
      color: 'gray',
      description: 'Policy is being prepared',
    },
    GENERATING: {
      label: 'Generating',
      color: 'blue',
      description: 'AI is generating the policy',
    },
    COMPLETED: {
      label: 'Completed',
      color: 'green',
      description: 'Policy generation complete',
    },
    FAILED: {
      label: 'Failed',
      color: 'red',
      description: 'Policy generation failed',
    },
    PUBLISHED: {
      label: 'Published',
      color: 'purple',
      description: 'Policy is published and active',
    },
    ARCHIVED: {
      label: 'Archived',
      color: 'yellow',
      description: 'Policy is archived',
    },
  };
  
  return statusInfo[status];
}

// ============================================================================
// Regulatory Area Utilities
// ============================================================================

/**
 * Get display name for regulatory area
 */
export function getRegulatoryAreaName(area: RegulatoryArea): string {
  const names: Record<RegulatoryArea, string> = {
    DATA_PROTECTION: 'Data Protection Act',
    AML_CFT: 'Anti-Money Laundering',
    CONSUMER_PROTECTION: 'Consumer Protection',
    CYBERSECURITY: 'Cybersecurity',
    DIGITAL_LENDING: 'Digital Lending Regulations',
    PAYMENT_SERVICES: 'Payment Services',
    BANKING: 'Banking Regulations',
    INSURANCE: 'Insurance Regulations',
    CAPITAL_MARKETS: 'Capital Markets',
    MICROFINANCE: 'Microfinance Regulations',
    SACCO: 'SACCO Regulations',
    TAX_COMPLIANCE: 'Tax Compliance',
    CORPORATE_GOVERNANCE: 'Corporate Governance',
    EMPLOYMENT: 'Employment Regulations',
    ENVIRONMENTAL: 'Environmental Compliance',
    OTHER: 'Other',
  };
  
  return names[area] || area;
}

/**
 * Get regulatory authority for area
 */
export function getRegulatoryAuthority(area: RegulatoryArea): string {
  const authorities: Record<RegulatoryArea, string> = {
    DATA_PROTECTION: 'Office of the Data Protection Commissioner (ODPC)',
    AML_CFT: 'Financial Reporting Centre (FRC)',
    CONSUMER_PROTECTION: 'Competition Authority of Kenya (CAK)',
    CYBERSECURITY: 'Communications Authority of Kenya (CA)',
    DIGITAL_LENDING: 'Central Bank of Kenya (CBK)',
    PAYMENT_SERVICES: 'Central Bank of Kenya (CBK)',
    BANKING: 'Central Bank of Kenya (CBK)',
    INSURANCE: 'Insurance Regulatory Authority (IRA)',
    CAPITAL_MARKETS: 'Capital Markets Authority (CMA)',
    MICROFINANCE: 'Central Bank of Kenya (CBK)',
    SACCO: 'SASRA',
    TAX_COMPLIANCE: 'Kenya Revenue Authority (KRA)',
    CORPORATE_GOVERNANCE: 'Various (sector-specific)',
    EMPLOYMENT: 'Ministry of Labour',
    ENVIRONMENTAL: 'NEMA',
    OTHER: 'Various',
  };
  
  return authorities[area] || 'Various';
}

// ============================================================================
// Email Templates
// ============================================================================

/**
 * Generate policy ready notification email
 */
export function generatePolicyReadyEmail(
  userName: string,
  policyTitle: string,
  policyUrl: string
): { subject: string; text: string; html: string } {
  return {
    subject: `Your policy "${policyTitle}" is ready!`,
    text: `
Hi ${userName},

Great news! Your policy "${policyTitle}" has been successfully generated.

You can view and edit your policy at: ${policyUrl}

What you can do next:
- Review the generated content
- Edit sections as needed
- Add or remove citations
- Export to PDF or DOCX
- Publish when ready

If you have any questions, feel free to reach out to our support team.

Best regards,
The SheriaBot Team
    `.trim(),
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <h2 style="color: #2563eb;">Your Policy is Ready! 🎉</h2>
    <p>Hi ${userName},</p>
    <p>Great news! Your policy <strong>"${policyTitle}"</strong> has been successfully generated.</p>
    <p style="text-align: center; margin: 30px 0;">
      <a href="${policyUrl}" 
         style="background-color: #2563eb; color: white; padding: 12px 24px; 
                text-decoration: none; border-radius: 6px; display: inline-block;">
        View Your Policy
      </a>
    </p>
    <h3>What you can do next:</h3>
    <ul style="color: #666;">
      <li>Review the generated content</li>
      <li>Edit sections as needed</li>
      <li>Add or remove citations</li>
      <li>Export to PDF or DOCX</li>
      <li>Publish when ready</li>
    </ul>
    <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
    <p style="color: #999; font-size: 12px;">
      Best regards,<br>
      The SheriaBot Team
    </p>
  </div>
</body>
</html>
    `.trim(),
  };
}

/**
 * Generate policy failed notification email
 */
export function generatePolicyFailedEmail(
  userName: string,
  policyTitle: string,
  errorMessage: string,
  retryUrl: string
): { subject: string; text: string; html: string } {
  return {
    subject: `Policy generation failed: "${policyTitle}"`,
    text: `
Hi ${userName},

Unfortunately, we encountered an issue generating your policy "${policyTitle}".

Error: ${errorMessage}

You can try generating the policy again at: ${retryUrl}

If the problem persists, please contact our support team.

Best regards,
The SheriaBot Team
    `.trim(),
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <h2 style="color: #dc2626;">Policy Generation Failed</h2>
    <p>Hi ${userName},</p>
    <p>Unfortunately, we encountered an issue generating your policy <strong>"${policyTitle}"</strong>.</p>
    <p style="background-color: #fef2f2; padding: 15px; border-radius: 6px; border-left: 4px solid #dc2626;">
      <strong>Error:</strong> ${errorMessage}
    </p>
    <p style="text-align: center; margin: 30px 0;">
      <a href="${retryUrl}" 
         style="background-color: #2563eb; color: white; padding: 12px 24px; 
                text-decoration: none; border-radius: 6px; display: inline-block;">
        Try Again
      </a>
    </p>
    <p style="color: #666; font-size: 14px;">
      If the problem persists, please contact our support team.
    </p>
    <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
    <p style="color: #999; font-size: 12px;">
      Best regards,<br>
      The SheriaBot Team
    </p>
  </div>
</body>
</html>
    `.trim(),
  };
}

// ============================================================================
// Export Utilities
// ============================================================================

/**
 * Generate export filename
 */
export function generateExportFilename(
  policyTitle: string,
  format: ExportFormat
): string {
  const sanitized = policyTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
  
  const timestamp = new Date().toISOString().split('T')[0];
  const extension = format.toLowerCase();
  
  return `${sanitized}-${timestamp}.${extension}`;
}

/**
 * Get MIME type for export format
 */
export function getExportMimeType(format: ExportFormat): string {
  const mimeTypes: Record<ExportFormat, string> = {
    PDF: 'application/pdf',
    DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    JSON: 'application/json',
    MARKDOWN: 'text/markdown',
  };
  
  return mimeTypes[format];
}
