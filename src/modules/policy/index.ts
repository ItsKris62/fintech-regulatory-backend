/**
 * Policy Module - Public API
 * Export all policy-related functionality
 */

// Main module
export { policyModule, PolicyModule } from './policy.module';

// Sub-modules
export { policyGenerator, PolicyGenerator } from './policy-generator';
export { policyExporter, PolicyExporter } from './policy-exporter';
export { policyComparator, PolicyComparator } from './policy-comparator';

// Types
export type {
  Policy,
  PolicyWithDetails,
  Citation,
  PolicyVersion,
  PolicyComment,
  PolicySection,
  PolicyStatus,
  RegulatoryArea,
  ExportFormat,
  PolicyGenerationParams,
  PolicyGenerationResult,
  PolicyRefinementParams,
  GenerationProgress,
  GenerationStage,
  AIGenerationResult,
  CitationExtract,
  ExportResult,
  ExportOptions,
  ComparisonResult,
  PolicySummary,
  SimilarityItem,
  DifferenceItem,
  CoverageAnalysis,
  CoverageGap,
  ComplianceAnalysis,
  AreaComplianceScore,
  ComplianceCheckItem,
  PolicyFilters,
  PaginatedPolicies,
} from './policy.types';

export {
  POLICY_CONSTANTS,
  ALL_REGULATORY_AREAS,
  REGULATORY_AREA_NAMES,
  PolicyError,
} from './policy.types';

export type { PolicyErrorCode } from './policy.types';

// Utilities (for use in other modules)
export {
  toPolicy,
  toPolicyWithDetails,
  toCitation,
  toVersion,
  extractSections,
  countWords,
  estimateReadingTime,
  generateTitle,
  truncate,
  extractCitationsFromContent,
  formatCitation,
  canEditPolicy,
  canPublishPolicy,
  canDeletePolicy,
  getStatusInfo,
  getRegulatoryAreaName,
  getRegulatoryAuthority,
  generateExportFilename,
  getExportMimeType,
  policyGenerationSchema,
  policyUpdateSchema,
  policyRefinementSchema,
  exportOptionsSchema,
  policyFiltersSchema,
} from './policy.utils';
