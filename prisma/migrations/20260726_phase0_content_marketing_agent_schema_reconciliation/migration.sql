-- Phase 0 schema-history reconciliation.
--
-- Several production schema families were added to prisma/schema.prisma in
-- earlier commits without matching version-controlled CREATE TABLE migration
-- history. This migration is intentionally additive and idempotent: it makes a
-- fresh migration replay capable of creating the required content, marketing,
-- and agent tables, while doing no destructive work in databases where those
-- objects already exist.

DO $$ BEGIN CREATE TYPE "ContactConsentStatus" AS ENUM ('PENDING', 'GRANTED', 'REVOKED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SuppressionReason" AS ENUM ('UNSUBSCRIBED', 'BOUNCED', 'COMPLAINED', 'MANUAL'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "MarketingCampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'PARTIALLY_SENT', 'FAILED', 'CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "CampaignSendStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'BOUNCED', 'COMPLAINED', 'UNSUBSCRIBED', 'SUPPRESSED_SKIPPED', 'NO_CONSENT_SKIPPED', 'FAILED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "MarketingTemplateKey" AS ENUM ('PILOT_INVITATION', 'REGULATOR_ACCESS_PROGRAM', 'PRODUCT_LAUNCH', 'COMPLIANCE_UPDATE', 'WEBINAR_INVITE', 'RESOURCE_DOWNLOAD', 'GENERIC_MARKETING', 'KENYAN_COMPLIANCE_BRIEF'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TYPE "MarketingTemplateKey" ADD VALUE IF NOT EXISTS 'KENYAN_COMPLIANCE_BRIEF';
DO $$ BEGIN CREATE TYPE "CampaignSendJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "ConsentAction" AS ENUM ('GRANTED', 'REVOKED', 'UPDATED', 'IMPORTED_LEGITIMATE_INTEREST'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "EmailEventType" AS ENUM ('SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'BOUNCED', 'COMPLAINED', 'DELAYED', 'FAILED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE "BlogPostStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'PUBLISHED', 'ARCHIVED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogSourceType" AS ENUM ('OFFICIAL', 'THIRD_PARTY', 'INTERNAL', 'MEDIA', 'INTERNATIONAL_STANDARD'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogJurisdiction" AS ENUM ('KE', 'MW', 'RW', 'NG', 'REGIONAL', 'GLOBAL'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogAuthorityType" AS ENUM ('CENTRAL_BANK', 'DATA_PROTECTION', 'AML_CFT', 'COMMUNICATIONS', 'SECURITIES', 'CONSUMER_PROTECTION', 'COMPETITION', 'GAZETTE', 'LEGAL_DATABASE', 'INTERNATIONAL_STANDARD', 'DEVELOPMENT_FINANCE', 'INDUSTRY_BODY', 'INTERNAL', 'OTHER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogMonitoringMethod" AS ENUM ('RSS', 'HTML_LISTING', 'API', 'MANUAL'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogMonitorStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'NEEDS_VERIFICATION', 'FAILING'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogMonitorLastRunStatus" AS ENUM ('SUCCESS', 'FAILED', 'NEVER_RUN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogSourceItemStatus" AS ENUM ('NEW', 'READY_FOR_SCORING', 'SCORED', 'DUPLICATE', 'DISMISSED', 'FETCH_FAILED', 'CONVERTED_TO_SUGGESTION'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogDiscoveryRunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL_SUCCESS', 'FAILED', 'SKIPPED_LOCKED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogVerificationStatus" AS ENUM ('PENDING', 'RUNNING', 'PASSED', 'NEEDS_REVIEW', 'BLOCKED', 'FAILED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogVerificationIssueSeverity" AS ENUM ('INFO', 'WARNING', 'BLOCKING'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogVerificationIssueType" AS ENUM ('MISSING_SOURCE', 'MISSING_OFFICIAL_SOURCE', 'INVALID_SOURCE_URL', 'PLACEHOLDER_SOURCE_URL', 'BROKEN_SOURCE_URL', 'JURISDICTION_MISMATCH', 'SOURCE_TYPE_MISMATCH', 'RISKY_LEGAL_CLAIM', 'UNSUPPORTED_OBLIGATION_LANGUAGE', 'MISSING_DISCLAIMER', 'MISSING_AI_REVIEW_WARNING', 'POSSIBLE_COPYING_RISK', 'EMPTY_CONTENT', 'WEAK_SOURCE_COVERAGE', 'OUTDATED_SOURCE', 'UNKNOWN_PUBLICATION_DATE', 'GENERATION_UNCERTAINTY', 'OTHER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogVerificationRunType" AS ENUM ('MANUAL', 'PRE_PUBLISH', 'SYSTEM'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogSuggestionPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogSuggestionStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED_FOR_DRAFT', 'DRAFT_CREATED', 'DISMISSED', 'DUPLICATE', 'NEEDS_MORE_SOURCES'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogArticleType" AS ENUM ('SINGLE_JURISDICTION_UPDATE', 'COUNTRY_SPECIFIC_GUIDE', 'CROSS_COUNTRY_COMPARISON', 'REGIONAL_TREND_ANALYSIS', 'EVERGREEN_EXPLAINER', 'PRODUCT_EDUCATION'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogSourceQuality" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'OFFICIAL'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogDraftGenerationStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogDraftGenerationProvider" AS ENUM ('ANTHROPIC', 'OPENAI', 'OTHER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "Company" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "domain" TEXT,
  "industry" TEXT,
  "regulatorMix" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "notes" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Company_domain_key" ON "Company"("domain");
CREATE INDEX IF NOT EXISTS "Company_name_idx" ON "Company"("name");
CREATE INDEX IF NOT EXISTS "Company_createdById_idx" ON "Company"("createdById");
CREATE INDEX IF NOT EXISTS "Company_deletedAt_idx" ON "Company"("deletedAt");

CREATE TABLE IF NOT EXISTS "Contact" (
  "id" TEXT NOT NULL,
  "companyId" TEXT,
  "email" TEXT NOT NULL,
  "firstName" TEXT,
  "lastName" TEXT,
  "role" TEXT,
  "phone" TEXT,
  "primaryRegulator" TEXT,
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "notes" TEXT,
  "consentStatus" "ContactConsentStatus" NOT NULL DEFAULT 'PENDING',
  "consentSource" TEXT,
  "consentTimestamp" TIMESTAMP(3),
  "suppressedAt" TIMESTAMP(3),
  "suppressedReason" "SuppressionReason",
  "lastEmailedAt" TIMESTAMP(3),
  "lastEmailOpenedAt" TIMESTAMP(3),
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Contact_email_key" ON "Contact"("email");
CREATE INDEX IF NOT EXISTS "Contact_email_idx" ON "Contact"("email");
CREATE INDEX IF NOT EXISTS "Contact_companyId_idx" ON "Contact"("companyId");
CREATE INDEX IF NOT EXISTS "Contact_consentStatus_idx" ON "Contact"("consentStatus");
CREATE INDEX IF NOT EXISTS "Contact_suppressedAt_idx" ON "Contact"("suppressedAt");
CREATE INDEX IF NOT EXISTS "Contact_createdById_idx" ON "Contact"("createdById");
CREATE INDEX IF NOT EXISTS "Contact_deletedAt_idx" ON "Contact"("deletedAt");

CREATE TABLE IF NOT EXISTS "ContactList" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "isDynamic" BOOLEAN NOT NULL DEFAULT false,
  "filterCriteria" JSONB,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "ContactList_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ContactList_name_key" ON "ContactList"("name");
CREATE INDEX IF NOT EXISTS "ContactList_createdById_idx" ON "ContactList"("createdById");
CREATE INDEX IF NOT EXISTS "ContactList_deletedAt_idx" ON "ContactList"("deletedAt");

CREATE TABLE IF NOT EXISTS "ContactListMembership" (
  "listId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "addedById" TEXT NOT NULL,
  CONSTRAINT "ContactListMembership_pkey" PRIMARY KEY ("listId", "contactId")
);
CREATE INDEX IF NOT EXISTS "ContactListMembership_contactId_idx" ON "ContactListMembership"("contactId");

CREATE TABLE IF NOT EXISTS "MarketingCampaign" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "templateKey" "MarketingTemplateKey" NOT NULL,
  "templateVariables" JSONB NOT NULL DEFAULT '{}',
  "status" "MarketingCampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "scheduledFor" TIMESTAMP(3),
  "listId" TEXT,
  "segmentFilter" JSONB,
  "createdById" TEXT NOT NULL,
  "sentAt" TIMESTAMP(3),
  "totalRecipients" INTEGER NOT NULL DEFAULT 0,
  "totalSent" INTEGER NOT NULL DEFAULT 0,
  "totalDelivered" INTEGER NOT NULL DEFAULT 0,
  "totalOpened" INTEGER NOT NULL DEFAULT 0,
  "totalClicked" INTEGER NOT NULL DEFAULT 0,
  "totalBounced" INTEGER NOT NULL DEFAULT 0,
  "totalUnsubscribed" INTEGER NOT NULL DEFAULT 0,
  "totalComplained" INTEGER NOT NULL DEFAULT 0,
  "totalSuppressedSkip" INTEGER NOT NULL DEFAULT 0,
  "totalNoConsentSkip" INTEGER NOT NULL DEFAULT 0,
  "totalFailed" INTEGER NOT NULL DEFAULT 0,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MarketingCampaign_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "MarketingCampaign_status_idx" ON "MarketingCampaign"("status");
CREATE INDEX IF NOT EXISTS "MarketingCampaign_createdById_idx" ON "MarketingCampaign"("createdById");
CREATE INDEX IF NOT EXISTS "MarketingCampaign_scheduledFor_idx" ON "MarketingCampaign"("scheduledFor");
CREATE INDEX IF NOT EXISTS "MarketingCampaign_sentAt_idx" ON "MarketingCampaign"("sentAt");

CREATE TABLE IF NOT EXISTS "CampaignSend" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "status" "CampaignSendStatus" NOT NULL DEFAULT 'PENDING',
  "messageId" TEXT,
  "unsubscribeTokenHash" TEXT,
  "sentAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "openedAt" TIMESTAMP(3),
  "firstClickedAt" TIMESTAMP(3),
  "bouncedAt" TIMESTAMP(3),
  "unsubscribedAt" TIMESTAMP(3),
  "complainedAt" TIMESTAMP(3),
  "suppressionReason" "SuppressionReason",
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CampaignSend_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CampaignSend_unsubscribeTokenHash_key" ON "CampaignSend"("unsubscribeTokenHash");
CREATE UNIQUE INDEX IF NOT EXISTS "CampaignSend_campaignId_contactId_key" ON "CampaignSend"("campaignId", "contactId");
CREATE INDEX IF NOT EXISTS "CampaignSend_messageId_idx" ON "CampaignSend"("messageId");
CREATE INDEX IF NOT EXISTS "CampaignSend_status_idx" ON "CampaignSend"("status");
CREATE INDEX IF NOT EXISTS "CampaignSend_sentAt_idx" ON "CampaignSend"("sentAt");

CREATE TABLE IF NOT EXISTS "SuppressionList" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "reason" "SuppressionReason" NOT NULL,
  "metadata" JSONB,
  "addedById" TEXT,
  "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SuppressionList_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SuppressionList_email_key" ON "SuppressionList"("email");
CREATE INDEX IF NOT EXISTS "SuppressionList_reason_idx" ON "SuppressionList"("reason");
CREATE INDEX IF NOT EXISTS "SuppressionList_addedAt_idx" ON "SuppressionList"("addedAt");

CREATE TABLE IF NOT EXISTS "EmailEvent" (
  "id" TEXT NOT NULL,
  "sendId" TEXT,
  "messageId" TEXT,
  "eventType" "EmailEventType" NOT NULL,
  "eventData" JSONB NOT NULL DEFAULT '{}',
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "EmailEvent_sendId_idx" ON "EmailEvent"("sendId");
CREATE INDEX IF NOT EXISTS "EmailEvent_messageId_idx" ON "EmailEvent"("messageId");
CREATE INDEX IF NOT EXISTS "EmailEvent_eventType_idx" ON "EmailEvent"("eventType");
CREATE INDEX IF NOT EXISTS "EmailEvent_occurredAt_idx" ON "EmailEvent"("occurredAt");

CREATE TABLE IF NOT EXISTS "ConsentRecord" (
  "id" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "action" "ConsentAction" NOT NULL,
  "source" TEXT NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "metadata" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ConsentRecord_contactId_idx" ON "ConsentRecord"("contactId");
CREATE INDEX IF NOT EXISTS "ConsentRecord_action_idx" ON "ConsentRecord"("action");
CREATE INDEX IF NOT EXISTS "ConsentRecord_occurredAt_idx" ON "ConsentRecord"("occurredAt");

CREATE TABLE IF NOT EXISTS "CampaignSendJob" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "status" "CampaignSendJobStatus" NOT NULL DEFAULT 'QUEUED',
  "totalContacts" INTEGER NOT NULL DEFAULT 0,
  "processed" INTEGER NOT NULL DEFAULT 0,
  "succeeded" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "skipped" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CampaignSendJob_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CampaignSendJob_campaignId_idx" ON "CampaignSendJob"("campaignId");
CREATE INDEX IF NOT EXISTS "CampaignSendJob_status_idx" ON "CampaignSendJob"("status");

CREATE TABLE IF NOT EXISTS "BlogPost" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "excerpt" TEXT,
  "content" TEXT,
  "htmlContent" TEXT,
  "coverImageUrl" TEXT,
  "category" TEXT NOT NULL,
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" "BlogPostStatus" NOT NULL DEFAULT 'DRAFT',
  "featured" BOOLEAN NOT NULL DEFAULT false,
  "jurisdiction" TEXT NOT NULL DEFAULT 'Kenya',
  "relatedRegulations" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "seoTitle" TEXT,
  "seoDescription" TEXT,
  "canonicalUrl" TEXT,
  "ogImageUrl" TEXT,
  "authorId" TEXT NOT NULL,
  "reviewerId" TEXT,
  "updatedById" TEXT,
  "publishedAt" TIMESTAMP(3),
  "lastReviewedAt" TIMESTAMP(3),
  "archivedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BlogPost_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "BlogPost_slug_key" ON "BlogPost"("slug");
CREATE INDEX IF NOT EXISTS "BlogPost_slug_idx" ON "BlogPost"("slug");
CREATE INDEX IF NOT EXISTS "BlogPost_status_idx" ON "BlogPost"("status");
CREATE INDEX IF NOT EXISTS "BlogPost_category_idx" ON "BlogPost"("category");
CREATE INDEX IF NOT EXISTS "BlogPost_featured_idx" ON "BlogPost"("featured");
CREATE INDEX IF NOT EXISTS "BlogPost_publishedAt_idx" ON "BlogPost"("publishedAt");
CREATE INDEX IF NOT EXISTS "BlogPost_deletedAt_idx" ON "BlogPost"("deletedAt");

CREATE TABLE IF NOT EXISTS "BlogPostSource" (
  "id" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "sourceType" "BlogSourceType" NOT NULL,
  "title" TEXT NOT NULL,
  "publisher" TEXT,
  "url" TEXT,
  "publishedAt" TIMESTAMP(3),
  "accessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BlogPostSource_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "BlogPostSource_postId_idx" ON "BlogPostSource"("postId");
CREATE INDEX IF NOT EXISTS "BlogPostSource_sourceType_idx" ON "BlogPostSource"("sourceType");

CREATE TABLE IF NOT EXISTS "BlogSourceMonitor" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "jurisdiction" "BlogJurisdiction" NOT NULL,
  "countryLabel" TEXT,
  "authorityType" "BlogAuthorityType" NOT NULL,
  "sourceType" "BlogSourceType" NOT NULL,
  "monitoringMethod" "BlogMonitoringMethod" NOT NULL DEFAULT 'MANUAL',
  "baseUrl" TEXT NOT NULL,
  "feedUrl" TEXT,
  "topics" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" "BlogMonitorStatus" NOT NULL DEFAULT 'NEEDS_VERIFICATION',
  "lastRunStatus" "BlogMonitorLastRunStatus" NOT NULL DEFAULT 'NEVER_RUN',
  "isOfficial" BOOLEAN NOT NULL DEFAULT true,
  "isActive" BOOLEAN NOT NULL DEFAULT false,
  "lastCheckedAt" TIMESTAMP(3),
  "lastSuccessfulRunAt" TIMESTAMP(3),
  "lastFailureAt" TIMESTAMP(3),
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "lastFailureReason" TEXT,
  "maxItemsPerRun" INTEGER NOT NULL DEFAULT 20,
  "fetchTimeoutMs" INTEGER NOT NULL DEFAULT 15000,
  "respectRobots" BOOLEAN NOT NULL DEFAULT true,
  "verificationStatus" TEXT NOT NULL DEFAULT 'NEEDS_VERIFICATION',
  "verifiedAt" TIMESTAMP(3),
  "verifiedById" TEXT,
  "notes" TEXT,
  "createdById" TEXT,
  "updatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "BlogSourceMonitor_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "BlogSourceMonitor_jurisdiction_baseUrl_key" ON "BlogSourceMonitor"("jurisdiction", "baseUrl");
CREATE INDEX IF NOT EXISTS "BlogSourceMonitor_jurisdiction_idx" ON "BlogSourceMonitor"("jurisdiction");
CREATE INDEX IF NOT EXISTS "BlogSourceMonitor_authorityType_idx" ON "BlogSourceMonitor"("authorityType");
CREATE INDEX IF NOT EXISTS "BlogSourceMonitor_sourceType_idx" ON "BlogSourceMonitor"("sourceType");
CREATE INDEX IF NOT EXISTS "BlogSourceMonitor_monitoringMethod_idx" ON "BlogSourceMonitor"("monitoringMethod");
CREATE INDEX IF NOT EXISTS "BlogSourceMonitor_status_idx" ON "BlogSourceMonitor"("status");
CREATE INDEX IF NOT EXISTS "BlogSourceMonitor_isActive_idx" ON "BlogSourceMonitor"("isActive");
CREATE INDEX IF NOT EXISTS "BlogSourceMonitor_deletedAt_idx" ON "BlogSourceMonitor"("deletedAt");

CREATE TABLE IF NOT EXISTS "BlogSourceItem" (
  "id" TEXT NOT NULL,
  "monitorId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "normalizedUrl" TEXT NOT NULL,
  "publisher" TEXT,
  "summary" TEXT,
  "jurisdiction" "BlogJurisdiction" NOT NULL,
  "authorityType" "BlogAuthorityType" NOT NULL,
  "sourceType" "BlogSourceType" NOT NULL,
  "publicationDate" TIMESTAMP(3),
  "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "contentHash" TEXT NOT NULL,
  "rawContentHash" TEXT,
  "status" "BlogSourceItemStatus" NOT NULL DEFAULT 'NEW',
  "failureReason" TEXT,
  "dismissedReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "BlogSourceItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "BlogSourceItem_monitorId_normalizedUrl_key" ON "BlogSourceItem"("monitorId", "normalizedUrl");
CREATE UNIQUE INDEX IF NOT EXISTS "BlogSourceItem_contentHash_key" ON "BlogSourceItem"("contentHash");
CREATE INDEX IF NOT EXISTS "BlogSourceItem_monitorId_idx" ON "BlogSourceItem"("monitorId");
CREATE INDEX IF NOT EXISTS "BlogSourceItem_jurisdiction_idx" ON "BlogSourceItem"("jurisdiction");
CREATE INDEX IF NOT EXISTS "BlogSourceItem_authorityType_idx" ON "BlogSourceItem"("authorityType");
CREATE INDEX IF NOT EXISTS "BlogSourceItem_sourceType_idx" ON "BlogSourceItem"("sourceType");
CREATE INDEX IF NOT EXISTS "BlogSourceItem_status_idx" ON "BlogSourceItem"("status");
CREATE INDEX IF NOT EXISTS "BlogSourceItem_publicationDate_idx" ON "BlogSourceItem"("publicationDate");
CREATE INDEX IF NOT EXISTS "BlogSourceItem_discoveredAt_idx" ON "BlogSourceItem"("discoveredAt");
CREATE INDEX IF NOT EXISTS "BlogSourceItem_deletedAt_idx" ON "BlogSourceItem"("deletedAt");

CREATE TABLE IF NOT EXISTS "BlogDiscoveryRun" (
  "id" TEXT NOT NULL,
  "monitorId" TEXT,
  "status" "BlogDiscoveryRunStatus" NOT NULL DEFAULT 'RUNNING',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "itemsFound" INTEGER NOT NULL DEFAULT 0,
  "itemsCreated" INTEGER NOT NULL DEFAULT 0,
  "duplicateCount" INTEGER NOT NULL DEFAULT 0,
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "errorMessage" TEXT,
  "triggeredBy" TEXT NOT NULL DEFAULT 'ADMIN',
  "triggeredByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BlogDiscoveryRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "BlogDiscoveryRun_monitorId_idx" ON "BlogDiscoveryRun"("monitorId");
CREATE INDEX IF NOT EXISTS "BlogDiscoveryRun_status_idx" ON "BlogDiscoveryRun"("status");
CREATE INDEX IF NOT EXISTS "BlogDiscoveryRun_startedAt_idx" ON "BlogDiscoveryRun"("startedAt");

CREATE TABLE IF NOT EXISTS "BlogVerificationRun" (
  "id" TEXT NOT NULL,
  "blogPostId" TEXT NOT NULL,
  "draftGenerationRunId" TEXT,
  "status" "BlogVerificationStatus" NOT NULL DEFAULT 'PENDING',
  "runType" "BlogVerificationRunType" NOT NULL DEFAULT 'MANUAL',
  "qualityScore" INTEGER NOT NULL DEFAULT 0,
  "sourceScore" INTEGER NOT NULL DEFAULT 0,
  "claimRiskScore" INTEGER NOT NULL DEFAULT 0,
  "jurisdictionScore" INTEGER NOT NULL DEFAULT 0,
  "readinessScore" INTEGER NOT NULL DEFAULT 0,
  "blockingIssueCount" INTEGER NOT NULL DEFAULT 0,
  "warningIssueCount" INTEGER NOT NULL DEFAULT 0,
  "infoIssueCount" INTEGER NOT NULL DEFAULT 0,
  "summary" TEXT,
  "recommendedAction" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "errorMessage" TEXT,
  "requestedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BlogVerificationRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "BlogVerificationRun_blogPostId_idx" ON "BlogVerificationRun"("blogPostId");
CREATE INDEX IF NOT EXISTS "BlogVerificationRun_draftGenerationRunId_idx" ON "BlogVerificationRun"("draftGenerationRunId");
CREATE INDEX IF NOT EXISTS "BlogVerificationRun_status_idx" ON "BlogVerificationRun"("status");
CREATE INDEX IF NOT EXISTS "BlogVerificationRun_runType_idx" ON "BlogVerificationRun"("runType");
CREATE INDEX IF NOT EXISTS "BlogVerificationRun_createdAt_idx" ON "BlogVerificationRun"("createdAt");

CREATE TABLE IF NOT EXISTS "BlogVerificationIssue" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "severity" "BlogVerificationIssueSeverity" NOT NULL,
  "issueType" "BlogVerificationIssueType" NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "recommendation" TEXT,
  "excerpt" TEXT,
  "paragraphIndex" INTEGER,
  "sentenceIndex" INTEGER,
  "sourceId" TEXT,
  "sourceUrl" TEXT,
  "claimText" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlogVerificationIssue_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "BlogVerificationIssue_runId_idx" ON "BlogVerificationIssue"("runId");
CREATE INDEX IF NOT EXISTS "BlogVerificationIssue_severity_idx" ON "BlogVerificationIssue"("severity");
CREATE INDEX IF NOT EXISTS "BlogVerificationIssue_issueType_idx" ON "BlogVerificationIssue"("issueType");

CREATE TABLE IF NOT EXISTS "BlogArticleSuggestion" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "suggestedSlug" TEXT,
  "summary" TEXT,
  "jurisdiction" "BlogJurisdiction" NOT NULL,
  "jurisdictions" "BlogJurisdiction"[] NOT NULL DEFAULT ARRAY[]::"BlogJurisdiction"[],
  "category" TEXT NOT NULL,
  "articleType" "BlogArticleType" NOT NULL,
  "priority" "BlogSuggestionPriority" NOT NULL DEFAULT 'MEDIUM',
  "status" "BlogSuggestionStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  "relevanceScore" INTEGER NOT NULL DEFAULT 0,
  "sourceQuality" "BlogSourceQuality" NOT NULL DEFAULT 'MEDIUM',
  "recommendedTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "targetAudience" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "reason" TEXT,
  "suggestedNextAction" TEXT,
  "requiresOfficialSource" BOOLEAN NOT NULL DEFAULT false,
  "requiresHumanReview" BOOLEAN NOT NULL DEFAULT true,
  "needsMoreSources" BOOLEAN NOT NULL DEFAULT false,
  "dismissedReason" TEXT,
  "dismissedAt" TIMESTAMP(3),
  "dismissedById" TEXT,
  "approvedAt" TIMESTAMP(3),
  "approvedById" TEXT,
  "blogPostId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "BlogArticleSuggestion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "BlogArticleSuggestion_blogPostId_key" ON "BlogArticleSuggestion"("blogPostId");
CREATE INDEX IF NOT EXISTS "BlogArticleSuggestion_jurisdiction_idx" ON "BlogArticleSuggestion"("jurisdiction");
CREATE INDEX IF NOT EXISTS "BlogArticleSuggestion_category_idx" ON "BlogArticleSuggestion"("category");
CREATE INDEX IF NOT EXISTS "BlogArticleSuggestion_articleType_idx" ON "BlogArticleSuggestion"("articleType");
CREATE INDEX IF NOT EXISTS "BlogArticleSuggestion_priority_idx" ON "BlogArticleSuggestion"("priority");
CREATE INDEX IF NOT EXISTS "BlogArticleSuggestion_status_idx" ON "BlogArticleSuggestion"("status");
CREATE INDEX IF NOT EXISTS "BlogArticleSuggestion_relevanceScore_idx" ON "BlogArticleSuggestion"("relevanceScore");
CREATE INDEX IF NOT EXISTS "BlogArticleSuggestion_createdAt_idx" ON "BlogArticleSuggestion"("createdAt");
CREATE INDEX IF NOT EXISTS "BlogArticleSuggestion_deletedAt_idx" ON "BlogArticleSuggestion"("deletedAt");

CREATE TABLE IF NOT EXISTS "BlogSuggestionSource" (
  "suggestionId" TEXT NOT NULL,
  "sourceItemId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlogSuggestionSource_pkey" PRIMARY KEY ("suggestionId", "sourceItemId")
);
CREATE INDEX IF NOT EXISTS "BlogSuggestionSource_sourceItemId_idx" ON "BlogSuggestionSource"("sourceItemId");

CREATE TABLE IF NOT EXISTS "AgentRun" (
  "id" TEXT NOT NULL,
  "agentType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "idempotencyKey" TEXT NOT NULL,
  "organizationId" TEXT,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
  "iterations" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "error" TEXT,
  "metadata" JSONB,
  CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AgentRun_idempotencyKey_key" ON "AgentRun"("idempotencyKey");

CREATE TABLE IF NOT EXISTS "AgentReport" (
  "id" TEXT NOT NULL,
  "agentRunId" TEXT NOT NULL,
  "summary" TEXT,
  "signals" JSONB,
  "recommendedActions" JSONB,
  "risks" JSONB,
  "humanApproved" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentReport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MarketingDraft" (
  "id" TEXT NOT NULL,
  "contentType" TEXT NOT NULL,
  "sourceSignalIds" JSONB NOT NULL DEFAULT '[]',
  "sourceFingerprint" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "brief" TEXT,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "agentRunId" TEXT NOT NULL,
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "reviewedBy" TEXT,
  "editedBody" TEXT,
  "metadata" JSONB,
  CONSTRAINT "MarketingDraft_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MarketingDraft_contentType_sourceFingerprint_key" ON "MarketingDraft"("contentType", "sourceFingerprint");
CREATE INDEX IF NOT EXISTS "MarketingDraft_contentType_idx" ON "MarketingDraft"("contentType");
CREATE INDEX IF NOT EXISTS "MarketingDraft_status_idx" ON "MarketingDraft"("status");
CREATE INDEX IF NOT EXISTS "MarketingDraft_agentRunId_idx" ON "MarketingDraft"("agentRunId");
CREATE INDEX IF NOT EXISTS "MarketingDraft_generatedAt_idx" ON "MarketingDraft"("generatedAt");

CREATE TABLE IF NOT EXISTS "RegulatorySignal" (
  "id" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "normalizedUrl" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "sourceItemId" TEXT,
  "sourceMonitorId" TEXT,
  "jurisdiction" TEXT NOT NULL,
  "regulatoryBody" TEXT NOT NULL,
  "documentType" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "affectedSectors" JSONB NOT NULL DEFAULT '[]',
  "affectedObligations" JSONB NOT NULL DEFAULT '[]',
  "effectiveDate" TIMESTAMP(3),
  "complianceWindowDays" INTEGER,
  "corpusGapDetected" BOOLEAN NOT NULL DEFAULT false,
  "corpusGapDetails" JSONB,
  "pilotFintechsAffected" JSONB NOT NULL DEFAULT '[]',
  "rawContent" TEXT,
  "agentRunId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'NEW',
  "providerTrace" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "reviewedAt" TIMESTAMP(3),
  CONSTRAINT "RegulatorySignal_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "RegulatorySignal_sourceUrl_contentHash_key" ON "RegulatorySignal"("sourceUrl", "contentHash");
CREATE INDEX IF NOT EXISTS "RegulatorySignal_normalizedUrl_idx" ON "RegulatorySignal"("normalizedUrl");
CREATE INDEX IF NOT EXISTS "RegulatorySignal_jurisdiction_idx" ON "RegulatorySignal"("jurisdiction");
CREATE INDEX IF NOT EXISTS "RegulatorySignal_regulatoryBody_idx" ON "RegulatorySignal"("regulatoryBody");
CREATE INDEX IF NOT EXISTS "RegulatorySignal_severity_idx" ON "RegulatorySignal"("severity");
CREATE INDEX IF NOT EXISTS "RegulatorySignal_status_idx" ON "RegulatorySignal"("status");
CREATE INDEX IF NOT EXISTS "RegulatorySignal_corpusGapDetected_idx" ON "RegulatorySignal"("corpusGapDetected");
CREATE INDEX IF NOT EXISTS "RegulatorySignal_agentRunId_idx" ON "RegulatorySignal"("agentRunId");
CREATE INDEX IF NOT EXISTS "RegulatorySignal_createdAt_idx" ON "RegulatorySignal"("createdAt");

CREATE TABLE IF NOT EXISTS "SalesOutreachDraft" (
  "id" TEXT NOT NULL,
  "sourceSignalId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "triggerReason" TEXT NOT NULL,
  "engagementContext" JSONB,
  "subject" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "priority" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "agentRunId" TEXT NOT NULL,
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "reviewedBy" TEXT,
  "editedBody" TEXT,
  "sourceFingerprint" TEXT NOT NULL,
  "metadata" JSONB,
  CONSTRAINT "SalesOutreachDraft_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SalesOutreachDraft_sourceFingerprint_key" ON "SalesOutreachDraft"("sourceFingerprint");
CREATE INDEX IF NOT EXISTS "SalesOutreachDraft_organizationId_idx" ON "SalesOutreachDraft"("organizationId");
CREATE INDEX IF NOT EXISTS "SalesOutreachDraft_status_idx" ON "SalesOutreachDraft"("status");
CREATE INDEX IF NOT EXISTS "SalesOutreachDraft_priority_idx" ON "SalesOutreachDraft"("priority");
CREATE INDEX IF NOT EXISTS "SalesOutreachDraft_agentRunId_idx" ON "SalesOutreachDraft"("agentRunId");
CREATE INDEX IF NOT EXISTS "SalesOutreachDraft_sourceSignalId_idx" ON "SalesOutreachDraft"("sourceSignalId");
CREATE INDEX IF NOT EXISTS "SalesOutreachDraft_generatedAt_idx" ON "SalesOutreachDraft"("generatedAt");

CREATE TABLE IF NOT EXISTS "BlogDraftGenerationRun" (
  "id" TEXT NOT NULL,
  "blogPostId" TEXT NOT NULL,
  "suggestionId" TEXT,
  "status" "BlogDraftGenerationStatus" NOT NULL DEFAULT 'PENDING',
  "provider" "BlogDraftGenerationProvider",
  "model" TEXT,
  "promptVersion" TEXT NOT NULL DEFAULT 'blog-draft-v1',
  "inputSourceCount" INTEGER NOT NULL DEFAULT 0,
  "inputTokenEstimate" INTEGER,
  "outputTokenEstimate" INTEGER,
  "costUsdEstimate" DOUBLE PRECISION,
  "errorMessage" TEXT,
  "generatedTitle" TEXT,
  "generatedExcerpt" TEXT,
  "generatedContent" TEXT,
  "generatedSeoTitle" TEXT,
  "generatedSeoDescription" TEXT,
  "generatedTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "reviewerNotes" TEXT,
  "uncertaintyFlags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "appliedToPost" BOOLEAN NOT NULL DEFAULT false,
  "appliedAt" TIMESTAMP(3),
  "appliedById" TEXT,
  "requestedById" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BlogDraftGenerationRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "BlogDraftGenerationRun_blogPostId_idx" ON "BlogDraftGenerationRun"("blogPostId");
CREATE INDEX IF NOT EXISTS "BlogDraftGenerationRun_suggestionId_idx" ON "BlogDraftGenerationRun"("suggestionId");
CREATE INDEX IF NOT EXISTS "BlogDraftGenerationRun_status_idx" ON "BlogDraftGenerationRun"("status");
CREATE INDEX IF NOT EXISTS "BlogDraftGenerationRun_createdAt_idx" ON "BlogDraftGenerationRun"("createdAt");

CREATE TABLE IF NOT EXISTS "BlogEditorialDigest" (
  "id" TEXT NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'GENERATED',
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMP(3),
  "sourceMonitorsChecked" INTEGER NOT NULL DEFAULT 0,
  "sourceItemsDiscovered" INTEGER NOT NULL DEFAULT 0,
  "highPrioritySuggestions" INTEGER NOT NULL DEFAULT 0,
  "urgentSuggestions" INTEGER NOT NULL DEFAULT 0,
  "approvedAwaitingDraft" INTEGER NOT NULL DEFAULT 0,
  "draftsAwaitingVerification" INTEGER NOT NULL DEFAULT 0,
  "blockedDrafts" INTEGER NOT NULL DEFAULT 0,
  "failingMonitors" INTEGER NOT NULL DEFAULT 0,
  "summaryJson" JSONB,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BlogEditorialDigest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "BlogEditorialDigest_periodStart_idx" ON "BlogEditorialDigest"("periodStart");
CREATE INDEX IF NOT EXISTS "BlogEditorialDigest_periodEnd_idx" ON "BlogEditorialDigest"("periodEnd");
CREATE INDEX IF NOT EXISTS "BlogEditorialDigest_status_idx" ON "BlogEditorialDigest"("status");

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Company_createdById_fkey') THEN ALTER TABLE "Company" ADD CONSTRAINT "Company_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Contact_companyId_fkey') THEN ALTER TABLE "Contact" ADD CONSTRAINT "Contact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Contact_createdById_fkey') THEN ALTER TABLE "Contact" ADD CONSTRAINT "Contact_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ContactList_createdById_fkey') THEN ALTER TABLE "ContactList" ADD CONSTRAINT "ContactList_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ContactListMembership_listId_fkey') THEN ALTER TABLE "ContactListMembership" ADD CONSTRAINT "ContactListMembership_listId_fkey" FOREIGN KEY ("listId") REFERENCES "ContactList"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ContactListMembership_contactId_fkey') THEN ALTER TABLE "ContactListMembership" ADD CONSTRAINT "ContactListMembership_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ContactListMembership_addedById_fkey') THEN ALTER TABLE "ContactListMembership" ADD CONSTRAINT "ContactListMembership_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MarketingCampaign_listId_fkey') THEN ALTER TABLE "MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_listId_fkey" FOREIGN KEY ("listId") REFERENCES "ContactList"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MarketingCampaign_createdById_fkey') THEN ALTER TABLE "MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CampaignSend_campaignId_fkey') THEN ALTER TABLE "CampaignSend" ADD CONSTRAINT "CampaignSend_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CampaignSend_contactId_fkey') THEN ALTER TABLE "CampaignSend" ADD CONSTRAINT "CampaignSend_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SuppressionList_addedById_fkey') THEN ALTER TABLE "SuppressionList" ADD CONSTRAINT "SuppressionList_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EmailEvent_sendId_fkey') THEN ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_sendId_fkey" FOREIGN KEY ("sendId") REFERENCES "CampaignSend"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ConsentRecord_contactId_fkey') THEN ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CampaignSendJob_campaignId_fkey') THEN ALTER TABLE "CampaignSendJob" ADD CONSTRAINT "CampaignSendJob_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BlogPost_authorId_fkey') THEN ALTER TABLE "BlogPost" ADD CONSTRAINT "BlogPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BlogPost_reviewerId_fkey') THEN ALTER TABLE "BlogPost" ADD CONSTRAINT "BlogPost_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BlogPost_updatedById_fkey') THEN ALTER TABLE "BlogPost" ADD CONSTRAINT "BlogPost_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BlogPostSource_postId_fkey') THEN ALTER TABLE "BlogPostSource" ADD CONSTRAINT "BlogPostSource_postId_fkey" FOREIGN KEY ("postId") REFERENCES "BlogPost"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BlogSourceMonitor_verifiedById_fkey') THEN ALTER TABLE "BlogSourceMonitor" ADD CONSTRAINT "BlogSourceMonitor_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BlogSourceMonitor_createdById_fkey') THEN ALTER TABLE "BlogSourceMonitor" ADD CONSTRAINT "BlogSourceMonitor_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BlogSourceMonitor_updatedById_fkey') THEN ALTER TABLE "BlogSourceMonitor" ADD CONSTRAINT "BlogSourceMonitor_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BlogSourceItem_monitorId_fkey') THEN ALTER TABLE "BlogSourceItem" ADD CONSTRAINT "BlogSourceItem_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "BlogSourceMonitor"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BlogDiscoveryRun_monitorId_fkey') THEN ALTER TABLE "BlogDiscoveryRun" ADD CONSTRAINT "BlogDiscoveryRun_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "BlogSourceMonitor"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BlogDiscoveryRun_triggeredByUserId_fkey') THEN ALTER TABLE "BlogDiscoveryRun" ADD CONSTRAINT "BlogDiscoveryRun_triggeredByUserId_fkey" FOREIGN KEY ("triggeredByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BlogVerificationRun_blogPostId_fkey') THEN ALTER TABLE "BlogVerificationRun" ADD CONSTRAINT "BlogVerificationRun_blogPostId_fkey" FOREIGN KEY ("blogPostId") REFERENCES "BlogPost"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BlogVerificationRun_requestedById_fkey') THEN ALTER TABLE "BlogVerificationRun" ADD CONSTRAINT "BlogVerificationRun_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BlogVerificationIssue_runId_fkey') THEN ALTER TABLE "BlogVerificationIssue" ADD CONSTRAINT "BlogVerificationIssue_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BlogVerificationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BlogArticleSuggestion_blogPostId_fkey') THEN ALTER TABLE "BlogArticleSuggestion" ADD CONSTRAINT "BlogArticleSuggestion_blogPostId_fkey" FOREIGN KEY ("blogPostId") REFERENCES "BlogPost"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BlogArticleSuggestion_dismissedById_fkey') THEN ALTER TABLE "BlogArticleSuggestion" ADD CONSTRAINT "BlogArticleSuggestion_dismissedById_fkey" FOREIGN KEY ("dismissedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BlogArticleSuggestion_approvedById_fkey') THEN ALTER TABLE "BlogArticleSuggestion" ADD CONSTRAINT "BlogArticleSuggestion_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BlogSuggestionSource_suggestionId_fkey') THEN ALTER TABLE "BlogSuggestionSource" ADD CONSTRAINT "BlogSuggestionSource_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "BlogArticleSuggestion"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BlogSuggestionSource_sourceItemId_fkey') THEN ALTER TABLE "BlogSuggestionSource" ADD CONSTRAINT "BlogSuggestionSource_sourceItemId_fkey" FOREIGN KEY ("sourceItemId") REFERENCES "BlogSourceItem"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BlogDraftGenerationRun_blogPostId_fkey') THEN ALTER TABLE "BlogDraftGenerationRun" ADD CONSTRAINT "BlogDraftGenerationRun_blogPostId_fkey" FOREIGN KEY ("blogPostId") REFERENCES "BlogPost"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BlogDraftGenerationRun_requestedById_fkey') THEN ALTER TABLE "BlogDraftGenerationRun" ADD CONSTRAINT "BlogDraftGenerationRun_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BlogDraftGenerationRun_appliedById_fkey') THEN ALTER TABLE "BlogDraftGenerationRun" ADD CONSTRAINT "BlogDraftGenerationRun_appliedById_fkey" FOREIGN KEY ("appliedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AgentReport_agentRunId_fkey') THEN ALTER TABLE "AgentReport" ADD CONSTRAINT "AgentReport_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE NO ACTION; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MarketingDraft_agentRunId_fkey') THEN ALTER TABLE "MarketingDraft" ADD CONSTRAINT "MarketingDraft_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE NO ACTION; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RegulatorySignal_agentRunId_fkey') THEN ALTER TABLE "RegulatorySignal" ADD CONSTRAINT "RegulatorySignal_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE NO ACTION; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SalesOutreachDraft_sourceSignalId_fkey') THEN ALTER TABLE "SalesOutreachDraft" ADD CONSTRAINT "SalesOutreachDraft_sourceSignalId_fkey" FOREIGN KEY ("sourceSignalId") REFERENCES "RegulatorySignal"("id") ON DELETE CASCADE ON UPDATE NO ACTION; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SalesOutreachDraft_organizationId_fkey') THEN ALTER TABLE "SalesOutreachDraft" ADD CONSTRAINT "SalesOutreachDraft_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE NO ACTION; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SalesOutreachDraft_agentRunId_fkey') THEN ALTER TABLE "SalesOutreachDraft" ADD CONSTRAINT "SalesOutreachDraft_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE NO ACTION; END IF; END $$;
