import { logger } from './logger';

export type VerifierMode = 'pre' | 'post';

export type VerificationStatus =
  | 'PRESENT'
  | 'MISSING_EXPECTED'
  | 'MISSING_UNEXPECTED'
  | 'CONFLICT'
  | 'WARN';

export type ObjectCategory =
  | 'TABLE'
  | 'COLUMN'
  | 'ENUM'
  | 'ENUM_VALUE'
  | 'INDEX'
  | 'FOREIGN_KEY';

export interface ExpectedColumn {
  name: string;
  dataType: string;
  isNullable: boolean;
  isPrimaryKey?: boolean;
}

export interface ExpectedTable {
  tableName: string;
  isPrerequisite?: boolean; // true if created prior to Phase 0 (e.g. User)
  columns: ExpectedColumn[];
}

export interface ExpectedEnum {
  enumName: string;
  isPrerequisite?: boolean;
  requiredValues: string[];
}

export interface ExpectedIndex {
  name: string;
  tableName: string;
  columns: string[];
  isUnique: boolean;
  isPrimaryKey?: boolean;
}

export interface ExpectedForeignKey {
  name: string;
  sourceTable: string;
  sourceColumns: string[];
  targetTable: string;
  targetColumns: string[];
  onDelete: string; // CASCADE, RESTRICT, SET NULL, NO ACTION
  onUpdate: string;
}

export interface VerificationItemResult {
  category: ObjectCategory;
  objectName: string;
  status: VerificationStatus;
  reason: string;
  requiredPostMigration: boolean;
}

export interface EnvironmentIdentity {
  appEnv?: string;
  databaseEnv?: string;
  databaseUrl?: string;
}

export interface EnvironmentSafetyResult {
  safe: boolean;
  environmentName: string;
  redactedUrl: string;
  reason?: string;
}

export interface SchemaVerificationResult {
  mode: VerifierMode;
  success: boolean;
  gateStatus: 'PASSED' | 'FAILED' | 'BLOCKED_ENVIRONMENT_SAFETY';
  environment: {
    appEnv: string;
    databaseEnv: string;
    redactedUrl: string;
  };
  summaryCounts: {
    totalChecked: number;
    present: number;
    missingExpected: number;
    missingUnexpected: number;
    conflict: number;
    warn: number;
  };
  results: VerificationItemResult[];
}

export interface QueryRunner {
  queryRaw<T = unknown>(query: string, ...params: unknown[]): Promise<T[]>;
}

// Raw SQL query result interfaces
export interface InformationSchemaTableRaw {
  table_name: string;
}

export interface InformationSchemaColumnRaw {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
}

export interface PgEnumRaw {
  enum_name: string;
  enum_value: string;
}

export interface PgIndexRaw {
  indexname: string;
  tablename: string;
  indexdef: string;
}

export interface PgConstraintRaw {
  constraint_name: string;
  source_table: string;
  source_column: string;
  target_table: string;
  target_column: string;
  on_delete: string;
  on_update: string;
}

/**
 * Utility to safely redact database connection string secrets (passwords, credentials).
 */
export function redactDatabaseUrl(url?: string): string {
  if (!url || url.trim() === '') {
    return '[UNCONFIGURED]';
  }

  try {
    // Matches schema://user:password@host:port/dbname
    return url.replace(/:\/\/[^:]+:[^@]+@/, '://*****:*****@');
  } catch {
    return '[REDACTED_INVALID_URL]';
  }
}

/**
 * Validates environment configuration and prevents execution against production or ambiguous targets.
 */
export function validateEnvironmentSafety(identity: EnvironmentIdentity): EnvironmentSafetyResult {
  const appEnv = (identity.appEnv || '').toLowerCase().trim();
  const dbEnv = (identity.databaseEnv || '').toLowerCase().trim();
  const url = (identity.databaseUrl || '').toLowerCase().trim();
  const redactedUrl = redactDatabaseUrl(identity.databaseUrl);

  if (!appEnv && !dbEnv) {
    return {
      safe: false,
      environmentName: 'MISSING_IDENTITY',
      redactedUrl,
      reason: 'Environment identity missing. APP_ENV or DATABASE_ENVIRONMENT must be explicitly set.',
    };
  }

  const isProdApp = appEnv === 'production' || appEnv === 'prod';
  const isProdDb = dbEnv === 'production' || dbEnv === 'prod';

  if (isProdApp || isProdDb) {
    return {
      safe: false,
      environmentName: 'PRODUCTION',
      redactedUrl,
      reason: 'Production environment detected in APP_ENV or DATABASE_ENVIRONMENT. Execution blocked.',
    };
  }

  if (appEnv && dbEnv && appEnv !== dbEnv) {
    return {
      safe: false,
      environmentName: 'CONFLICTING_IDENTITY',
      redactedUrl,
      reason: `Environment indicators conflict: APP_ENV='${appEnv}' vs DATABASE_ENVIRONMENT='${dbEnv}'.`,
    };
  }

  // URL keyword secondary check
  if (url.includes('prod-db') || url.includes('production-db') || (url.includes('prod') && !url.includes('staging'))) {
    return {
      safe: false,
      environmentName: 'PRODUCTION_URL_INDICATOR',
      redactedUrl,
      reason: 'Target DATABASE_URL matches known production indicators.',
    };
  }

  const envName = dbEnv || appEnv || 'CUSTOM_STAGING_OR_LOCAL';
  return {
    safe: true,
    environmentName: envName,
    redactedUrl,
  };
}

/**
 * Phase 0 Inventory Specification (All 27 Tables, Enums, Indexes, FKs)
 */
export const COMPLETE_PHASE0_INVENTORY: {
  tables: ExpectedTable[];
  enums: ExpectedEnum[];
  indexes: ExpectedIndex[];
  foreignKeys: ExpectedForeignKey[];
} = {
  enums: [
    { enumName: 'ContactConsentStatus', requiredValues: ['PENDING', 'GRANTED', 'REVOKED'] },
    { enumName: 'SuppressionReason', requiredValues: ['UNSUBSCRIBED', 'BOUNCED', 'COMPLAINED', 'MANUAL'] },
    { enumName: 'MarketingCampaignStatus', requiredValues: ['DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'PARTIALLY_SENT', 'FAILED', 'CANCELLED'] },
    { enumName: 'CampaignSendStatus', requiredValues: ['PENDING', 'SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'BOUNCED', 'COMPLAINED', 'UNSUBSCRIBED', 'SUPPRESSED_SKIPPED', 'NO_CONSENT_SKIPPED', 'FAILED'] },
    { enumName: 'MarketingTemplateKey', requiredValues: ['PILOT_INVITATION', 'REGULATOR_ACCESS_PROGRAM', 'PRODUCT_LAUNCH', 'COMPLIANCE_UPDATE', 'WEBINAR_INVITE', 'RESOURCE_DOWNLOAD', 'GENERIC_MARKETING', 'KENYAN_COMPLIANCE_BRIEF'] },
    { enumName: 'CampaignSendJobStatus', requiredValues: ['QUEUED', 'RUNNING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED'] },
    { enumName: 'ConsentAction', requiredValues: ['GRANTED', 'REVOKED', 'UPDATED', 'IMPORTED_LEGITIMATE_INTEREST'] },
    { enumName: 'EmailEventType', requiredValues: ['SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'BOUNCED', 'COMPLAINED', 'DELAYED', 'FAILED'] },

    { enumName: 'BlogPostStatus', requiredValues: ['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'ARCHIVED'] },
    { enumName: 'BlogSourceType', requiredValues: ['OFFICIAL', 'THIRD_PARTY', 'INTERNAL', 'MEDIA', 'INTERNATIONAL_STANDARD'] },
    { enumName: 'BlogJurisdiction', requiredValues: ['KE', 'MW', 'RW', 'NG', 'REGIONAL', 'GLOBAL'] },
    { enumName: 'BlogAuthorityType', requiredValues: ['CENTRAL_BANK', 'DATA_PROTECTION', 'AML_CFT', 'COMMUNICATIONS', 'SECURITIES', 'CONSUMER_PROTECTION', 'COMPETITION', 'GAZETTE', 'LEGAL_DATABASE', 'INTERNATIONAL_STANDARD', 'DEVELOPMENT_FINANCE', 'INDUSTRY_BODY', 'INTERNAL', 'OTHER'] },
    { enumName: 'BlogMonitoringMethod', requiredValues: ['RSS', 'HTML_LISTING', 'API', 'MANUAL'] },
    { enumName: 'BlogMonitorStatus', requiredValues: ['ACTIVE', 'INACTIVE', 'NEEDS_VERIFICATION', 'FAILING'] },
    { enumName: 'BlogMonitorLastRunStatus', requiredValues: ['SUCCESS', 'FAILED', 'NEVER_RUN'] },
    { enumName: 'BlogSourceItemStatus', requiredValues: ['NEW', 'READY_FOR_SCORING', 'SCORED', 'DUPLICATE', 'DISMISSED', 'FETCH_FAILED', 'CONVERTED_TO_SUGGESTION'] },
    { enumName: 'BlogDiscoveryRunStatus', requiredValues: ['RUNNING', 'SUCCESS', 'PARTIAL_SUCCESS', 'FAILED', 'SKIPPED_LOCKED'] },
    { enumName: 'BlogVerificationStatus', requiredValues: ['PENDING', 'RUNNING', 'PASSED', 'NEEDS_REVIEW', 'BLOCKED', 'FAILED'] },
    { enumName: 'BlogVerificationIssueSeverity', requiredValues: ['INFO', 'WARNING', 'BLOCKING'] },
    { enumName: 'BlogVerificationIssueType', requiredValues: ['MISSING_SOURCE', 'MISSING_OFFICIAL_SOURCE', 'INVALID_SOURCE_URL', 'PLACEHOLDER_SOURCE_URL', 'BROKEN_SOURCE_URL', 'JURISDICTION_MISMATCH', 'SOURCE_TYPE_MISMATCH', 'RISKY_LEGAL_CLAIM', 'UNSUPPORTED_OBLIGATION_LANGUAGE', 'MISSING_DISCLAIMER', 'MISSING_AI_REVIEW_WARNING', 'POSSIBLE_COPYING_RISK', 'EMPTY_CONTENT', 'WEAK_SOURCE_COVERAGE', 'OUTDATED_SOURCE', 'UNKNOWN_PUBLICATION_DATE', 'GENERATION_UNCERTAINTY', 'OTHER'] },
    { enumName: 'BlogVerificationRunType', requiredValues: ['MANUAL', 'PRE_PUBLISH', 'SYSTEM'] },
    { enumName: 'BlogSuggestionPriority', requiredValues: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] },
    { enumName: 'BlogSuggestionStatus', requiredValues: ['PENDING_REVIEW', 'APPROVED_FOR_DRAFT', 'DRAFT_CREATED', 'DISMISSED', 'DUPLICATE', 'NEEDS_MORE_SOURCES'] },
    { enumName: 'BlogArticleType', requiredValues: ['SINGLE_JURISDICTION_UPDATE', 'COUNTRY_SPECIFIC_GUIDE', 'CROSS_COUNTRY_COMPARISON', 'REGIONAL_TREND_ANALYSIS', 'EVERGREEN_EXPLAINER', 'PRODUCT_EDUCATION'] },
    { enumName: 'BlogSourceQuality', requiredValues: ['LOW', 'MEDIUM', 'HIGH', 'OFFICIAL'] },
    { enumName: 'BlogDraftGenerationStatus', requiredValues: ['PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED'] },
    { enumName: 'BlogDraftGenerationProvider', requiredValues: ['ANTHROPIC', 'OPENAI', 'OTHER'] },
  ],
  tables: [
    { tableName: 'Company', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'domain', dataType: 'text', isNullable: true }] },
    { tableName: 'Contact', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'email', dataType: 'text', isNullable: false }] },
    { tableName: 'ContactList', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'name', dataType: 'text', isNullable: false }] },
    { tableName: 'ContactListMembership', columns: [{ name: 'listId', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'contactId', dataType: 'text', isNullable: false, isPrimaryKey: true }] },
    { tableName: 'MarketingCampaign', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'templateKey', dataType: 'USER-DEFINED', isNullable: false }] },
    { tableName: 'CampaignSend', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'unsubscribeTokenHash', dataType: 'text', isNullable: true }] },
    { tableName: 'SuppressionList', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'email', dataType: 'text', isNullable: false }] },
    { tableName: 'EmailEvent', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'eventType', dataType: 'USER-DEFINED', isNullable: false }] },
    { tableName: 'ConsentRecord', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'action', dataType: 'USER-DEFINED', isNullable: false }] },
    { tableName: 'CampaignSendJob', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'status', dataType: 'USER-DEFINED', isNullable: false }] },
    { tableName: 'BlogPost', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'slug', dataType: 'text', isNullable: false }] },
    { tableName: 'BlogPostSource', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'postId', dataType: 'text', isNullable: false }] },
    { tableName: 'BlogSourceMonitor', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'jurisdiction', dataType: 'USER-DEFINED', isNullable: false }, { name: 'baseUrl', dataType: 'text', isNullable: false }] },
    { tableName: 'BlogSourceItem', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'contentHash', dataType: 'text', isNullable: false }, { name: 'monitorId', dataType: 'text', isNullable: false }, { name: 'normalizedUrl', dataType: 'text', isNullable: false }] },
    { tableName: 'BlogDiscoveryRun', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }] },
    { tableName: 'BlogVerificationRun', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }] },
    { tableName: 'BlogVerificationIssue', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }] },
    { tableName: 'BlogArticleSuggestion', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'blogPostId', dataType: 'text', isNullable: true }] },
    { tableName: 'BlogSuggestionSource', columns: [{ name: 'suggestionId', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'sourceItemId', dataType: 'text', isNullable: false, isPrimaryKey: true }] },
    { tableName: 'AgentRun', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'idempotencyKey', dataType: 'text', isNullable: false }] },
    { tableName: 'AgentReport', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }] },
    { tableName: 'MarketingDraft', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'contentType', dataType: 'text', isNullable: false }, { name: 'sourceFingerprint', dataType: 'text', isNullable: false }] },
    { tableName: 'RegulatorySignal', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'sourceUrl', dataType: 'text', isNullable: false }, { name: 'contentHash', dataType: 'text', isNullable: false }] },
    { tableName: 'SalesOutreachDraft', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'sourceFingerprint', dataType: 'text', isNullable: false }] },
    { tableName: 'BlogDraftGenerationRun', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }] },
    { tableName: 'BlogEditorialDigest', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }] },
    { tableName: 'AutomationApproval', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'idempotencyKey', dataType: 'text', isNullable: true }] },
  ],
  indexes: [
    { name: 'Contact_email_key', tableName: 'Contact', columns: ['email'], isUnique: true },
    { name: 'ContactList_name_key', tableName: 'ContactList', columns: ['name'], isUnique: true },
    { name: 'ContactListMembership_pkey', tableName: 'ContactListMembership', columns: ['listId', 'contactId'], isUnique: true, isPrimaryKey: true },
    { name: 'MarketingCampaign_status_idx', tableName: 'MarketingCampaign', columns: ['status'], isUnique: false },
    { name: 'CampaignSend_campaignId_contactId_key', tableName: 'CampaignSend', columns: ['campaignId', 'contactId'], isUnique: true },
    { name: 'CampaignSend_unsubscribeTokenHash_key', tableName: 'CampaignSend', columns: ['unsubscribeTokenHash'], isUnique: true },
    { name: 'BlogPost_slug_key', tableName: 'BlogPost', columns: ['slug'], isUnique: true },
    { name: 'BlogSourceMonitor_jurisdiction_baseUrl_key', tableName: 'BlogSourceMonitor', columns: ['jurisdiction', 'baseUrl'], isUnique: true },
    { name: 'BlogSourceItem_monitorId_normalizedUrl_key', tableName: 'BlogSourceItem', columns: ['monitorId', 'normalizedUrl'], isUnique: true },
    { name: 'BlogSourceItem_contentHash_key', tableName: 'BlogSourceItem', columns: ['contentHash'], isUnique: true },
    { name: 'BlogArticleSuggestion_blogPostId_key', tableName: 'BlogArticleSuggestion', columns: ['blogPostId'], isUnique: true },
    { name: 'BlogSuggestionSource_pkey', tableName: 'BlogSuggestionSource', columns: ['suggestionId', 'sourceItemId'], isUnique: true, isPrimaryKey: true },
    { name: 'AgentRun_idempotencyKey_key', tableName: 'AgentRun', columns: ['idempotencyKey'], isUnique: true },
    { name: 'MarketingDraft_contentType_sourceFingerprint_key', tableName: 'MarketingDraft', columns: ['contentType', 'sourceFingerprint'], isUnique: true },
    { name: 'RegulatorySignal_sourceUrl_contentHash_key', tableName: 'RegulatorySignal', columns: ['sourceUrl', 'contentHash'], isUnique: true },
    { name: 'SalesOutreachDraft_sourceFingerprint_key', tableName: 'SalesOutreachDraft', columns: ['sourceFingerprint'], isUnique: true },
    { name: 'AutomationApproval_idempotencyKey_key', tableName: 'AutomationApproval', columns: ['idempotencyKey'], isUnique: true },
  ],
  foreignKeys: [
    { name: 'Company_createdById_fkey', sourceTable: 'Company', sourceColumns: ['createdById'], targetTable: 'User', targetColumns: ['id'], onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    { name: 'Contact_companyId_fkey', sourceTable: 'Contact', sourceColumns: ['companyId'], targetTable: 'Company', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'Contact_createdById_fkey', sourceTable: 'Contact', sourceColumns: ['createdById'], targetTable: 'User', targetColumns: ['id'], onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    { name: 'ContactList_createdById_fkey', sourceTable: 'ContactList', sourceColumns: ['createdById'], targetTable: 'User', targetColumns: ['id'], onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    { name: 'ContactListMembership_listId_fkey', sourceTable: 'ContactListMembership', sourceColumns: ['listId'], targetTable: 'ContactList', targetColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'CASCADE' },
    { name: 'ContactListMembership_contactId_fkey', sourceTable: 'ContactListMembership', sourceColumns: ['contactId'], targetTable: 'Contact', targetColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'CASCADE' },
    { name: 'ContactListMembership_addedById_fkey', sourceTable: 'ContactListMembership', sourceColumns: ['addedById'], targetTable: 'User', targetColumns: ['id'], onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    { name: 'MarketingCampaign_listId_fkey', sourceTable: 'MarketingCampaign', sourceColumns: ['listId'], targetTable: 'ContactList', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'MarketingCampaign_createdById_fkey', sourceTable: 'MarketingCampaign', sourceColumns: ['createdById'], targetTable: 'User', targetColumns: ['id'], onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    { name: 'CampaignSend_campaignId_fkey', sourceTable: 'CampaignSend', sourceColumns: ['campaignId'], targetTable: 'MarketingCampaign', targetColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'CASCADE' },
    { name: 'CampaignSend_contactId_fkey', sourceTable: 'CampaignSend', sourceColumns: ['contactId'], targetTable: 'Contact', targetColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'CASCADE' },
    { name: 'SuppressionList_addedById_fkey', sourceTable: 'SuppressionList', sourceColumns: ['addedById'], targetTable: 'User', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'EmailEvent_sendId_fkey', sourceTable: 'EmailEvent', sourceColumns: ['sendId'], targetTable: 'CampaignSend', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'ConsentRecord_contactId_fkey', sourceTable: 'ConsentRecord', sourceColumns: ['contactId'], targetTable: 'Contact', targetColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'CASCADE' },
    { name: 'CampaignSendJob_campaignId_fkey', sourceTable: 'CampaignSendJob', sourceColumns: ['campaignId'], targetTable: 'MarketingCampaign', targetColumns: ['id'], onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    { name: 'BlogPost_authorId_fkey', sourceTable: 'BlogPost', sourceColumns: ['authorId'], targetTable: 'User', targetColumns: ['id'], onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    { name: 'BlogPost_reviewerId_fkey', sourceTable: 'BlogPost', sourceColumns: ['reviewerId'], targetTable: 'User', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'BlogPost_updatedById_fkey', sourceTable: 'BlogPost', sourceColumns: ['updatedById'], targetTable: 'User', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'BlogPostSource_postId_fkey', sourceTable: 'BlogPostSource', sourceColumns: ['postId'], targetTable: 'BlogPost', targetColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'CASCADE' },
    { name: 'BlogSourceMonitor_verifiedById_fkey', sourceTable: 'BlogSourceMonitor', sourceColumns: ['verifiedById'], targetTable: 'User', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'BlogSourceMonitor_createdById_fkey', sourceTable: 'BlogSourceMonitor', sourceColumns: ['createdById'], targetTable: 'User', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'BlogSourceMonitor_updatedById_fkey', sourceTable: 'BlogSourceMonitor', sourceColumns: ['updatedById'], targetTable: 'User', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'BlogSourceItem_monitorId_fkey', sourceTable: 'BlogSourceItem', sourceColumns: ['monitorId'], targetTable: 'BlogSourceMonitor', targetColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'CASCADE' },
    { name: 'BlogDiscoveryRun_monitorId_fkey', sourceTable: 'BlogDiscoveryRun', sourceColumns: ['monitorId'], targetTable: 'BlogSourceMonitor', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'BlogDiscoveryRun_triggeredByUserId_fkey', sourceTable: 'BlogDiscoveryRun', sourceColumns: ['triggeredByUserId'], targetTable: 'User', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'BlogVerificationRun_blogPostId_fkey', sourceTable: 'BlogVerificationRun', sourceColumns: ['blogPostId'], targetTable: 'BlogPost', targetColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'CASCADE' },
    { name: 'BlogVerificationRun_requestedById_fkey', sourceTable: 'BlogVerificationRun', sourceColumns: ['requestedById'], targetTable: 'User', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'BlogVerificationIssue_runId_fkey', sourceTable: 'BlogVerificationIssue', sourceColumns: ['runId'], targetTable: 'BlogVerificationRun', targetColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'CASCADE' },
    { name: 'BlogArticleSuggestion_blogPostId_fkey', sourceTable: 'BlogArticleSuggestion', sourceColumns: ['blogPostId'], targetTable: 'BlogPost', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'BlogArticleSuggestion_dismissedById_fkey', sourceTable: 'BlogArticleSuggestion', sourceColumns: ['dismissedById'], targetTable: 'User', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'BlogArticleSuggestion_approvedById_fkey', sourceTable: 'BlogArticleSuggestion', sourceColumns: ['approvedById'], targetTable: 'User', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'BlogSuggestionSource_suggestionId_fkey', sourceTable: 'BlogSuggestionSource', sourceColumns: ['suggestionId'], targetTable: 'BlogArticleSuggestion', targetColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'CASCADE' },
    { name: 'BlogSuggestionSource_sourceItemId_fkey', sourceTable: 'BlogSuggestionSource', sourceColumns: ['sourceItemId'], targetTable: 'BlogSourceItem', targetColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'CASCADE' },
    { name: 'BlogDraftGenerationRun_blogPostId_fkey', sourceTable: 'BlogDraftGenerationRun', sourceColumns: ['blogPostId'], targetTable: 'BlogPost', targetColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'CASCADE' },
    { name: 'BlogDraftGenerationRun_requestedById_fkey', sourceTable: 'BlogDraftGenerationRun', sourceColumns: ['requestedById'], targetTable: 'User', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'BlogDraftGenerationRun_appliedById_fkey', sourceTable: 'BlogDraftGenerationRun', sourceColumns: ['appliedById'], targetTable: 'User', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
  ],
};

/**
 * SheriaBot Pack 1 — Editorial Intelligence Inventory
 * Governing spec: docs/editorial-intelligence/phase-b-*.md (Phase B.1 approved).
 * Additive to COMPLETE_PHASE0_INVENTORY above — see ALL_EXPECTED_SCHEMA_INVENTORY,
 * which is what verifyCompleteSchema actually checks against.
 *
 * NOTE: "ContentOpsAlert_dedupe_key" (a raw SQL COALESCE expression unique index —
 * see prisma/migrations/20260727020000_content_ops_alert/migration.sql) is
 * intentionally NOT listed in `indexes` below. This engine's index-column parser
 * (a naive first-paren-group regex) cannot correctly parse an expression index
 * containing its own nested parentheses — attempting to check it here would
 * produce false CONFLICT results, not a genuine gap. That index must be verified
 * manually (e.g. `\d "ContentOpsAlert"` in psql) until a dedicated
 * expression-index-aware check is added. See docs/editorial-intelligence/
 * phase-c-schema-verification.md.
 */
export const PACK1_EDITORIAL_INTELLIGENCE_INVENTORY: {
  tables: ExpectedTable[];
  enums: ExpectedEnum[];
  indexes: ExpectedIndex[];
  foreignKeys: ExpectedForeignKey[];
} = {
  enums: [
    { enumName: 'ContentOpsAlertNotificationStatus', requiredValues: ['NOT_REQUIRED', 'PENDING', 'SENT', 'FAILED', 'SUPPRESSED'] },
    { enumName: 'BlogEditorialRecommendation', requiredValues: ['PRIORITISE_NOW', 'QUEUE', 'MONITOR', 'REJECT', 'HUMAN_REVIEW_REQUIRED'] },
    { enumName: 'BlogEditorialTriageStatus', requiredValues: ['PENDING', 'RUNNING', 'COMPLETE', 'FAILED'] },
    { enumName: 'BlogResearchPackStatus', requiredValues: ['DRAFT', 'COMPLETE', 'SUPERSEDED', 'FAILED'] },
    { enumName: 'BlogResearchSourceCategory', requiredValues: ['OFFICIAL_REGULATOR', 'LEGISLATION', 'OFFICIAL_GUIDANCE', 'APPROVED_CORPUS', 'REPUTABLE_NEWS', 'INDUSTRY_SOURCE', 'COMPANY_SOURCE', 'USER_GENERATED', 'UNVERIFIED'] },
    { enumName: 'BlogClaimCategory', requiredValues: ['LEGAL_OBLIGATION', 'DEADLINE', 'PENALTY', 'REGULATOR_AUTHORITY', 'LICENSING_REQUIREMENT', 'REPORTING_REQUIREMENT', 'SECURITY_REQUIREMENT', 'DATA_PROTECTION_REQUIREMENT', 'NUMERICAL_CLAIM', 'FACTUAL_EVENT', 'INTERPRETATION', 'RECOMMENDATION', 'MARKETING_STATEMENT'] },
    { enumName: 'BlogClaimVerificationStatus', requiredValues: ['VERIFIED', 'PARTIALLY_SUPPORTED', 'UNSUPPORTED', 'CONTRADICTED', 'STALE_SOURCE', 'HUMAN_REVIEW_REQUIRED'] },
    { enumName: 'BlogFreshnessRiskTier', requiredValues: ['HIGH_RISK', 'NORMAL', 'EVERGREEN'] },
    { enumName: 'BlogFreshnessAction', requiredValues: ['FRESH', 'REVIEW_SOON', 'REVISION_REQUIRED', 'URGENT_REVISION', 'ARCHIVE_RECOMMENDED', 'HUMAN_REVIEW_REQUIRED'] },
    { enumName: 'BlogRevisionPriority', requiredValues: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] },
    { enumName: 'BlogRevisionStatus', requiredValues: ['PENDING_REVIEW', 'ACCEPTED', 'IN_PROGRESS', 'RESOLVED', 'DISMISSED'] },
    // Additive value on the pre-existing BlogVerificationIssueType enum. Not
    // marked isPrerequisite: in this engine's pre/post model, isPrerequisite
    // means "must already exist independent of any migration in this repo"
    // (e.g. the User table) — the enum itself was created by an earlier Phase 0
    // migration in this same repo, so it's an ordinary expected object, exactly
    // like every other ALL_EXPECTED_SCHEMA_INVENTORY entry.
    { enumName: 'BlogVerificationIssueType', requiredValues: ['SEMANTIC_CLAIM_ISSUE'] },
  ],
  tables: [
    { tableName: 'ContentOpsAlert', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'type', dataType: 'text', isNullable: false }, { name: 'workflowKey', dataType: 'text', isNullable: true }, { name: 'entityId', dataType: 'text', isNullable: false }] },
    { tableName: 'BlogEditorialTriageRun', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'sourceItemId', dataType: 'text', isNullable: true }, { name: 'suggestionId', dataType: 'text', isNullable: true }, { name: 'inputHash', dataType: 'text', isNullable: false }] },
    { tableName: 'BlogResearchPack', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'blogPostId', dataType: 'text', isNullable: true }, { name: 'suggestionId', dataType: 'text', isNullable: true }, { name: 'inputHash', dataType: 'text', isNullable: false }, { name: 'sourceSetHash', dataType: 'text', isNullable: false }] },
    { tableName: 'BlogResearchPackSource', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'researchPackId', dataType: 'text', isNullable: false }, { name: 'category', dataType: 'USER-DEFINED', isNullable: false }] },
    { tableName: 'BlogFreshnessReview', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'blogPostId', dataType: 'text', isNullable: false }, { name: 'contentHash', dataType: 'text', isNullable: false }, { name: 'sourceSetHash', dataType: 'text', isNullable: false }] },
    { tableName: 'BlogRevisionRequest', columns: [{ name: 'id', dataType: 'text', isNullable: false, isPrimaryKey: true }, { name: 'blogPostId', dataType: 'text', isNullable: false }, { name: 'idempotencyKey', dataType: 'text', isNullable: false }] },
    // Additive-column checks on pre-existing tables. Not marked isPrerequisite —
    // see the BlogVerificationIssueType comment above for why: these tables were
    // created by an earlier Phase 0 migration in this same repo, so like every
    // other Phase 0 object they're "expected but not guaranteed present yet" in
    // pre-mode, not an external must-already-exist prerequisite.
    { tableName: 'BlogVerificationRun', columns: [{ name: 'contentHash', dataType: 'text', isNullable: true }, { name: 'sourceSetHash', dataType: 'text', isNullable: true }, { name: 'promptVersion', dataType: 'text', isNullable: true }] },
    { tableName: 'BlogVerificationIssue', columns: [{ name: 'claimCategory', dataType: 'USER-DEFINED', isNullable: true }, { name: 'claimVerificationStatus', dataType: 'USER-DEFINED', isNullable: true }, { name: 'confidence', dataType: 'integer', isNullable: true }, { name: 'claimHash', dataType: 'text', isNullable: true }, { name: 'reviewProvenance', dataType: 'jsonb', isNullable: true }] },
  ],
  indexes: [
    { name: 'RegulatorySignal_sourceItemId_idx', tableName: 'RegulatorySignal', columns: ['sourceItemId'], isUnique: false },
    { name: 'BlogEditorialTriageRun_sourceItemId_version_key', tableName: 'BlogEditorialTriageRun', columns: ['sourceItemId', 'version'], isUnique: true },
    { name: 'BlogEditorialTriageRun_suggestionId_version_key', tableName: 'BlogEditorialTriageRun', columns: ['suggestionId', 'version'], isUnique: true },
    { name: 'BlogEditorialTriageRun_suggestionId_idx', tableName: 'BlogEditorialTriageRun', columns: ['suggestionId'], isUnique: false },
    { name: 'BlogEditorialTriageRun_recommendation_idx', tableName: 'BlogEditorialTriageRun', columns: ['recommendation'], isUnique: false },
    { name: 'BlogEditorialTriageRun_status_idx', tableName: 'BlogEditorialTriageRun', columns: ['status'], isUnique: false },
    { name: 'BlogEditorialTriageRun_createdAt_idx', tableName: 'BlogEditorialTriageRun', columns: ['createdAt'], isUnique: false },
    { name: 'BlogResearchPack_blogPostId_version_key', tableName: 'BlogResearchPack', columns: ['blogPostId', 'version'], isUnique: true },
    { name: 'BlogResearchPack_suggestionId_version_key', tableName: 'BlogResearchPack', columns: ['suggestionId', 'version'], isUnique: true },
    { name: 'BlogResearchPack_suggestionId_idx', tableName: 'BlogResearchPack', columns: ['suggestionId'], isUnique: false },
    { name: 'BlogResearchPack_status_idx', tableName: 'BlogResearchPack', columns: ['status'], isUnique: false },
    { name: 'BlogResearchPack_createdAt_idx', tableName: 'BlogResearchPack', columns: ['createdAt'], isUnique: false },
    { name: 'BlogResearchPackSource_researchPackId_idx', tableName: 'BlogResearchPackSource', columns: ['researchPackId'], isUnique: false },
    { name: 'BlogResearchPackSource_sourceItemId_idx', tableName: 'BlogResearchPackSource', columns: ['sourceItemId'], isUnique: false },
    { name: 'BlogResearchPackSource_category_idx', tableName: 'BlogResearchPackSource', columns: ['category'], isUnique: false },
    { name: 'BlogVerificationIssue_claimHash_idx', tableName: 'BlogVerificationIssue', columns: ['claimHash'], isUnique: false },
    { name: 'BlogFreshnessReview_blogPostId_createdAt_idx', tableName: 'BlogFreshnessReview', columns: ['blogPostId', 'createdAt'], isUnique: false },
    { name: 'BlogFreshnessReview_action_idx', tableName: 'BlogFreshnessReview', columns: ['action'], isUnique: false },
    { name: 'BlogFreshnessReview_nextReviewAt_idx', tableName: 'BlogFreshnessReview', columns: ['nextReviewAt'], isUnique: false },
    { name: 'BlogFreshnessReview_status_idx', tableName: 'BlogFreshnessReview', columns: ['status'], isUnique: false },
    { name: 'BlogRevisionRequest_idempotencyKey_key', tableName: 'BlogRevisionRequest', columns: ['idempotencyKey'], isUnique: true },
    { name: 'BlogRevisionRequest_blogPostId_status_idx', tableName: 'BlogRevisionRequest', columns: ['blogPostId', 'status'], isUnique: false },
    { name: 'BlogRevisionRequest_freshnessReviewId_idx', tableName: 'BlogRevisionRequest', columns: ['freshnessReviewId'], isUnique: false },
    { name: 'BlogRevisionRequest_status_priority_idx', tableName: 'BlogRevisionRequest', columns: ['status', 'priority'], isUnique: false },
    { name: 'BlogRevisionRequest_createdAt_idx', tableName: 'BlogRevisionRequest', columns: ['createdAt'], isUnique: false },
    { name: 'ContentOpsAlert_status_severity_idx', tableName: 'ContentOpsAlert', columns: ['status', 'severity'], isUnique: false },
    { name: 'ContentOpsAlert_entityType_entityId_idx', tableName: 'ContentOpsAlert', columns: ['entityType', 'entityId'], isUnique: false },
    { name: 'ContentOpsAlert_workflowKey_lastSeenAt_idx', tableName: 'ContentOpsAlert', columns: ['workflowKey', 'lastSeenAt'], isUnique: false },
    { name: 'ContentOpsAlert_createdAt_idx', tableName: 'ContentOpsAlert', columns: ['createdAt'], isUnique: false },
  ],
  foreignKeys: [
    { name: 'RegulatorySignal_sourceItemId_fkey', sourceTable: 'RegulatorySignal', sourceColumns: ['sourceItemId'], targetTable: 'BlogSourceItem', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'BlogEditorialTriageRun_sourceItemId_fkey', sourceTable: 'BlogEditorialTriageRun', sourceColumns: ['sourceItemId'], targetTable: 'BlogSourceItem', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'BlogEditorialTriageRun_suggestionId_fkey', sourceTable: 'BlogEditorialTriageRun', sourceColumns: ['suggestionId'], targetTable: 'BlogArticleSuggestion', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'BlogEditorialTriageRun_agentRunId_fkey', sourceTable: 'BlogEditorialTriageRun', sourceColumns: ['agentRunId'], targetTable: 'AgentRun', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'BlogResearchPack_blogPostId_fkey', sourceTable: 'BlogResearchPack', sourceColumns: ['blogPostId'], targetTable: 'BlogPost', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'BlogResearchPack_suggestionId_fkey', sourceTable: 'BlogResearchPack', sourceColumns: ['suggestionId'], targetTable: 'BlogArticleSuggestion', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'BlogResearchPack_reviewedById_fkey', sourceTable: 'BlogResearchPack', sourceColumns: ['reviewedById'], targetTable: 'User', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'BlogResearchPackSource_researchPackId_fkey', sourceTable: 'BlogResearchPackSource', sourceColumns: ['researchPackId'], targetTable: 'BlogResearchPack', targetColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'CASCADE' },
    { name: 'BlogResearchPackSource_sourceItemId_fkey', sourceTable: 'BlogResearchPackSource', sourceColumns: ['sourceItemId'], targetTable: 'BlogSourceItem', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'BlogResearchPackSource_postSourceId_fkey', sourceTable: 'BlogResearchPackSource', sourceColumns: ['postSourceId'], targetTable: 'BlogPostSource', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'BlogFreshnessReview_blogPostId_fkey', sourceTable: 'BlogFreshnessReview', sourceColumns: ['blogPostId'], targetTable: 'BlogPost', targetColumns: ['id'], onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    { name: 'BlogFreshnessReview_agentRunId_fkey', sourceTable: 'BlogFreshnessReview', sourceColumns: ['agentRunId'], targetTable: 'AgentRun', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'BlogRevisionRequest_blogPostId_fkey', sourceTable: 'BlogRevisionRequest', sourceColumns: ['blogPostId'], targetTable: 'BlogPost', targetColumns: ['id'], onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    { name: 'BlogRevisionRequest_freshnessReviewId_fkey', sourceTable: 'BlogRevisionRequest', sourceColumns: ['freshnessReviewId'], targetTable: 'BlogFreshnessReview', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'BlogRevisionRequest_requestedById_fkey', sourceTable: 'BlogRevisionRequest', sourceColumns: ['requestedById'], targetTable: 'User', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'BlogRevisionRequest_assignedToId_fkey', sourceTable: 'BlogRevisionRequest', sourceColumns: ['assignedToId'], targetTable: 'User', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'BlogRevisionRequest_approvedById_fkey', sourceTable: 'BlogRevisionRequest', sourceColumns: ['approvedById'], targetTable: 'User', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'ContentOpsAlert_acknowledgedById_fkey', sourceTable: 'ContentOpsAlert', sourceColumns: ['acknowledgedById'], targetTable: 'User', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
    { name: 'ContentOpsAlert_resolvedById_fkey', sourceTable: 'ContentOpsAlert', sourceColumns: ['resolvedById'], targetTable: 'User', targetColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' },
  ],
};

/**
 * Union of the Phase 0 baseline and Pack 1's additions — this is what
 * verifyCompleteSchema actually iterates. Kept as a separate merged constant
 * (rather than mutating COMPLETE_PHASE0_INVENTORY in place) so the Phase 0
 * baseline stays independently readable/importable.
 */
export const ALL_EXPECTED_SCHEMA_INVENTORY: {
  tables: ExpectedTable[];
  enums: ExpectedEnum[];
  indexes: ExpectedIndex[];
  foreignKeys: ExpectedForeignKey[];
} = {
  tables: [...COMPLETE_PHASE0_INVENTORY.tables, ...PACK1_EDITORIAL_INTELLIGENCE_INVENTORY.tables],
  enums: [...COMPLETE_PHASE0_INVENTORY.enums, ...PACK1_EDITORIAL_INTELLIGENCE_INVENTORY.enums],
  indexes: [...COMPLETE_PHASE0_INVENTORY.indexes, ...PACK1_EDITORIAL_INTELLIGENCE_INVENTORY.indexes],
  foreignKeys: [...COMPLETE_PHASE0_INVENTORY.foreignKeys, ...PACK1_EDITORIAL_INTELLIGENCE_INVENTORY.foreignKeys],
};

/**
 * Main verification engine for Content, Blog, Agent & Marketing Schema.
 */
export async function verifyCompleteSchema(
  mode: VerifierMode,
  identity: EnvironmentIdentity,
  queryRunner?: QueryRunner
): Promise<SchemaVerificationResult> {
  const safety = validateEnvironmentSafety(identity);

  const result: SchemaVerificationResult = {
    mode,
    success: false,
    gateStatus: 'FAILED',
    environment: {
      appEnv: identity.appEnv || 'UNSET',
      databaseEnv: identity.databaseEnv || 'UNSET',
      redactedUrl: safety.redactedUrl,
    },
    summaryCounts: {
      totalChecked: 0,
      present: 0,
      missingExpected: 0,
      missingUnexpected: 0,
      conflict: 0,
      warn: 0,
    },
    results: [],
  };

  if (!safety.safe) {
    result.gateStatus = 'BLOCKED_ENVIRONMENT_SAFETY';
    result.results.push({
      category: 'TABLE',
      objectName: 'ENVIRONMENT_SAFETY_GATE',
      status: 'CONFLICT',
      reason: safety.reason || 'Environment safety check failed.',
      requiredPostMigration: true,
    });
    result.summaryCounts.conflict++;
    result.summaryCounts.totalChecked++;
    return result;
  }

  if (!queryRunner) {
    result.gateStatus = 'FAILED';
    result.results.push({
      category: 'TABLE',
      objectName: 'QUERY_RUNNER',
      status: 'MISSING_UNEXPECTED',
      reason: 'No query runner provided to database schema verifier.',
      requiredPostMigration: true,
    });
    result.summaryCounts.missingUnexpected++;
    result.summaryCounts.totalChecked++;
    return result;
  }

  try {
    // 1. Fetch tables
    const tablesRaw = await queryRunner.queryRaw<InformationSchemaTableRaw>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    const tableSet = new Set(tablesRaw.map((t) => t.table_name));

    // 2. Fetch columns
    const columnsRaw = await queryRunner.queryRaw<InformationSchemaColumnRaw>(
      `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public'`
    );
    const columnMap = new Map<string, Map<string, { dataType: string; isNullable: boolean }>>();
    for (const c of columnsRaw) {
      if (!columnMap.has(c.table_name)) {
        columnMap.set(c.table_name, new Map());
      }
      columnMap.get(c.table_name)!.set(c.column_name, {
        dataType: c.data_type,
        isNullable: c.is_nullable.toUpperCase() === 'YES',
      });
    }

    // 3. Fetch enums
    const enumsRaw = await queryRunner.queryRaw<PgEnumRaw>(
      `SELECT t.typname AS enum_name, e.enumlabel AS enum_value 
       FROM pg_type t 
       JOIN pg_enum e ON t.oid = e.enumtypid 
       JOIN pg_namespace n ON n.oid = t.typnamespace 
       WHERE n.nspname = 'public'`
    );
    const enumMap = new Map<string, Set<string>>();
    for (const e of enumsRaw) {
      if (!enumMap.has(e.enum_name)) {
        enumMap.set(e.enum_name, new Set());
      }
      enumMap.get(e.enum_name)!.add(e.enum_value);
    }

    // 4. Fetch Indexes
    const indexesRaw = await queryRunner.queryRaw<PgIndexRaw>(
      `SELECT indexname, tablename, indexdef FROM pg_indexes WHERE schemaname = 'public'`
    );
    const indexMap = new Map<string, { tablename: string; indexdef: string }>();
    for (const idx of indexesRaw) {
      indexMap.set(idx.indexname, { tablename: idx.tablename, indexdef: idx.indexdef });
    }

    // 5. Fetch Foreign Keys
    const fksRaw = await queryRunner.queryRaw<PgConstraintRaw>(
      `SELECT tc.constraint_name,
        tc.table_name AS source_table,
        kcu.column_name AS source_column,
        ccu.table_name AS target_table,
        ccu.column_name AS target_column,
        rc.delete_rule AS on_delete,
        rc.update_rule AS on_update
       FROM information_schema.table_constraints AS tc
       JOIN information_schema.key_column_usage AS kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.referential_constraints AS rc
         ON tc.constraint_name = rc.constraint_name
       JOIN information_schema.constraint_column_usage AS ccu
         ON ccu.constraint_name = tc.constraint_name
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`
    );
    const fkMap = new Map<string, PgConstraintRaw>();
    for (const fk of fksRaw) {
      fkMap.set(fk.constraint_name, fk);
    }

    // --- Verify Tables & Columns ---
    for (const table of ALL_EXPECTED_SCHEMA_INVENTORY.tables) {
      result.summaryCounts.totalChecked++;
      const exists = tableSet.has(table.tableName);

      if (!exists) {
        const itemStatus: VerificationStatus = table.isPrerequisite ? 'MISSING_UNEXPECTED' : 'MISSING_EXPECTED';
        result.results.push({
          category: 'TABLE',
          objectName: table.tableName,
          status: itemStatus,
          reason: `Table '${table.tableName}' is missing from schema 'public'.`,
          requiredPostMigration: true,
        });
        if (itemStatus === 'MISSING_EXPECTED') result.summaryCounts.missingExpected++;
        else result.summaryCounts.missingUnexpected++;
        continue;
      }

      result.results.push({
        category: 'TABLE',
        objectName: table.tableName,
        status: 'PRESENT',
        reason: `Table '${table.tableName}' exists in schema 'public'.`,
        requiredPostMigration: true,
      });
      result.summaryCounts.present++;

      // Targeted column checks
      const actualCols = columnMap.get(table.tableName) || new Map();
      for (const expectedCol of table.columns) {
        result.summaryCounts.totalChecked++;
        const actualCol = actualCols.get(expectedCol.name);

        if (!actualCol) {
          result.results.push({
            category: 'COLUMN',
            objectName: `${table.tableName}.${expectedCol.name}`,
            status: 'MISSING_EXPECTED',
            reason: `Column '${expectedCol.name}' missing from table '${table.tableName}'.`,
            requiredPostMigration: true,
          });
          result.summaryCounts.missingExpected++;
        } else {
          // Check type / nullability
          const expectedTypeNorm = expectedCol.dataType.toLowerCase();
          const actualTypeNorm = actualCol.dataType.toLowerCase();
          const isUserDefined = expectedTypeNorm === 'user-defined';
          const typeMatch = isUserDefined || actualTypeNorm.includes(expectedTypeNorm);

          if (!typeMatch || actualCol.isNullable !== expectedCol.isNullable) {
            result.results.push({
              category: 'COLUMN',
              objectName: `${table.tableName}.${expectedCol.name}`,
              status: 'CONFLICT',
              reason: `Column mismatch: expected type '${expectedCol.dataType}' (nullable=${expectedCol.isNullable}), got type '${actualCol.dataType}' (nullable=${actualCol.isNullable}).`,
              requiredPostMigration: true,
            });
            result.summaryCounts.conflict++;
          } else {
            result.results.push({
              category: 'COLUMN',
              objectName: `${table.tableName}.${expectedCol.name}`,
              status: 'PRESENT',
              reason: `Column '${expectedCol.name}' present with matching type '${actualCol.dataType}'.`,
              requiredPostMigration: true,
            });
            result.summaryCounts.present++;
          }
        }
      }
    }

    // --- Verify Enums & Values ---
    for (const expectedEnum of ALL_EXPECTED_SCHEMA_INVENTORY.enums) {
      result.summaryCounts.totalChecked++;
      const actualValues = enumMap.get(expectedEnum.enumName);

      if (!actualValues) {
        result.results.push({
          category: 'ENUM',
          objectName: expectedEnum.enumName,
          status: expectedEnum.isPrerequisite ? 'MISSING_UNEXPECTED' : 'MISSING_EXPECTED',
          reason: `Enum '${expectedEnum.enumName}' missing from schema 'public'.`,
          requiredPostMigration: true,
        });
        if (expectedEnum.isPrerequisite) result.summaryCounts.missingUnexpected++;
        else result.summaryCounts.missingExpected++;
        continue;
      }

      result.results.push({
        category: 'ENUM',
        objectName: expectedEnum.enumName,
        status: 'PRESENT',
        reason: `Enum '${expectedEnum.enumName}' exists.`,
        requiredPostMigration: true,
      });
      result.summaryCounts.present++;

      for (const val of expectedEnum.requiredValues) {
        result.summaryCounts.totalChecked++;
        if (!actualValues.has(val)) {
          result.results.push({
            category: 'ENUM_VALUE',
            objectName: `${expectedEnum.enumName}.${val}`,
            status: 'MISSING_EXPECTED',
            reason: `Enum value '${val}' missing from enum '${expectedEnum.enumName}'.`,
            requiredPostMigration: true,
          });
          result.summaryCounts.missingExpected++;
        } else {
          result.results.push({
            category: 'ENUM_VALUE',
            objectName: `${expectedEnum.enumName}.${val}`,
            status: 'PRESENT',
            reason: `Enum value '${val}' exists.`,
            requiredPostMigration: true,
          });
          result.summaryCounts.present++;
        }
      }
    }

    // --- Verify Indexes ---
    for (const expectedIdx of ALL_EXPECTED_SCHEMA_INVENTORY.indexes) {
      result.summaryCounts.totalChecked++;
      const actualIdx = indexMap.get(expectedIdx.name);

      if (!actualIdx) {
        result.results.push({
          category: 'INDEX',
          objectName: expectedIdx.name,
          status: 'MISSING_EXPECTED',
          reason: `Index/Constraint '${expectedIdx.name}' missing.`,
          requiredPostMigration: true,
        });
        result.summaryCounts.missingExpected++;
        continue;
      }

      const defLower = actualIdx.indexdef.toLowerCase();
      const tableMatch = actualIdx.tablename === expectedIdx.tableName;
      const isUniqueDef = defLower.includes('unique index');
      const uniqueMatch = expectedIdx.isUnique ? isUniqueDef : !isUniqueDef;

      // Extract column list inside indexdef parentheses: CREATE UNIQUE INDEX name ON table (col1, col2)
      const parenMatch = actualIdx.indexdef.match(/\(([^)]+)\)/);
      const colsInIndex = parenMatch
        ? parenMatch[1]
            .toLowerCase()
            .split(',')
            .map((c) => c.trim().replace(/^"|"$/g, ''))
        : [];
      const expectedColsNorm = expectedIdx.columns.map((c) => c.toLowerCase());
      const colMatch =
        colsInIndex.length === expectedColsNorm.length &&
        expectedColsNorm.every((col, i) => colsInIndex[i] === col);

      if (!tableMatch || !uniqueMatch || !colMatch) {
        result.results.push({
          category: 'INDEX',
          objectName: expectedIdx.name,
          status: 'CONFLICT',
          reason: `Index '${expectedIdx.name}' definition mismatch: expected table=${expectedIdx.tableName}, unique=${expectedIdx.isUnique}, cols=[${expectedIdx.columns.join(', ')}]. Got: ${actualIdx.indexdef}`,
          requiredPostMigration: true,
        });
        result.summaryCounts.conflict++;
      } else {
        result.results.push({
          category: 'INDEX',
          objectName: expectedIdx.name,
          status: 'PRESENT',
          reason: `Index '${expectedIdx.name}' matched on table '${expectedIdx.tableName}'.`,
          requiredPostMigration: true,
        });
        result.summaryCounts.present++;
      }
    }

    // --- Verify Foreign Keys ---
    for (const expectedFk of ALL_EXPECTED_SCHEMA_INVENTORY.foreignKeys) {
      result.summaryCounts.totalChecked++;
      const actualFk = fkMap.get(expectedFk.name);

      if (!actualFk) {
        result.results.push({
          category: 'FOREIGN_KEY',
          objectName: expectedFk.name,
          status: 'MISSING_EXPECTED',
          reason: `Foreign key constraint '${expectedFk.name}' missing.`,
          requiredPostMigration: true,
        });
        result.summaryCounts.missingExpected++;
        continue;
      }

      const srcTableMatch = actualFk.source_table === expectedFk.sourceTable;
      const srcColMatch = expectedFk.sourceColumns.includes(actualFk.source_column);
      const tgtTableMatch = actualFk.target_table === expectedFk.targetTable;
      const tgtColMatch = expectedFk.targetColumns.includes(actualFk.target_column);
      const onDeleteMatch = actualFk.on_delete.toUpperCase() === expectedFk.onDelete.toUpperCase();

      if (!srcTableMatch || !srcColMatch || !tgtTableMatch || !tgtColMatch || !onDeleteMatch) {
        result.results.push({
          category: 'FOREIGN_KEY',
          objectName: expectedFk.name,
          status: 'CONFLICT',
          reason: `FK '${expectedFk.name}' mismatch: expected (${expectedFk.sourceTable}.${expectedFk.sourceColumns[0]} -> ${expectedFk.targetTable}.${expectedFk.targetColumns[0]}, ON DELETE ${expectedFk.onDelete}). Got (${actualFk.source_table}.${actualFk.source_column} -> ${actualFk.target_table}.${actualFk.target_column}, ON DELETE ${actualFk.on_delete}).`,
          requiredPostMigration: true,
        });
        result.summaryCounts.conflict++;
      } else {
        result.results.push({
          category: 'FOREIGN_KEY',
          objectName: expectedFk.name,
          status: 'PRESENT',
          reason: `Foreign Key '${expectedFk.name}' present and matching.`,
          requiredPostMigration: true,
        });
        result.summaryCounts.present++;
      }
    }

    // Evaluate Mode & Exit Status Logic
    if (mode === 'pre') {
      // Pre mode fails ONLY on conflict, missing unexpected (prerequisite), or zero checked
      const hasPreFailures =
        result.summaryCounts.conflict > 0 ||
        result.summaryCounts.missingUnexpected > 0 ||
        result.summaryCounts.totalChecked === 0;

      result.success = !hasPreFailures;
      result.gateStatus = result.success ? 'PASSED' : 'FAILED';
    } else {
      // Post mode fails on ANY missing, conflict, or unexpected
      const hasPostFailures =
        result.summaryCounts.missingExpected > 0 ||
        result.summaryCounts.missingUnexpected > 0 ||
        result.summaryCounts.conflict > 0 ||
        result.summaryCounts.totalChecked === 0;

      result.success = !hasPostFailures;
      result.gateStatus = result.success ? 'PASSED' : 'FAILED';
    }
  } catch (err: unknown) {
    const error = err as Error;
    result.success = false;
    result.gateStatus = 'FAILED';
    result.results.push({
      category: 'TABLE',
      objectName: 'CATALOGUE_QUERY',
      status: 'CONFLICT',
      reason: `Catalogue query error: ${error.message}`,
      requiredPostMigration: true,
    });
    result.summaryCounts.conflict++;
    logger.error({ type: 'schema_verifier_catalog_error', error: error.message }, 'Failed executing catalogue queries.');
  }

  return result;
}
