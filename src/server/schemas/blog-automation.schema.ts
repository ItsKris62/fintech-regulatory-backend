import { z } from 'zod';
import {
  BlogJurisdiction,
  BlogAuthorityType,
  BlogMonitoringMethod,
  BlogMonitorStatus,
  BlogSourceType,
  BlogSourceItemStatus,
  BlogDiscoveryRunStatus,
  BlogSuggestionPriority,
  BlogSuggestionStatus,
  BlogArticleType,
  BlogSourceQuality,
  BlogVerificationStatus,
  BlogVerificationRunType,
} from '@prisma/client';

export const blogVerificationStatusSchema = z.nativeEnum(BlogVerificationStatus);
export const blogVerificationRunTypeSchema = z.nativeEnum(BlogVerificationRunType);

export const blogJurisdictionSchema = z.nativeEnum(BlogJurisdiction);
export const blogAuthorityTypeSchema = z.nativeEnum(BlogAuthorityType);
export const blogMonitoringMethodSchema = z.nativeEnum(BlogMonitoringMethod);
export const blogMonitorStatusSchema = z.nativeEnum(BlogMonitorStatus);
export const blogSourceTypeSchema = z.nativeEnum(BlogSourceType);
export const blogSourceItemStatusSchema = z.nativeEnum(BlogSourceItemStatus);
export const blogDiscoveryRunStatusSchema = z.nativeEnum(BlogDiscoveryRunStatus);
export const blogSuggestionPrioritySchema = z.nativeEnum(BlogSuggestionPriority);
export const blogSuggestionStatusSchema = z.nativeEnum(BlogSuggestionStatus);
export const blogArticleTypeSchema = z.nativeEnum(BlogArticleType);
export const blogSourceQualitySchema = z.nativeEnum(BlogSourceQuality);

// Strict URL validator to block SSRF vectors
const isSafeUrl = (urlStr: string) => {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname.toLowerCase();

    // Block exactly match domains/ips
    const blocklist = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', 'example.com'];
    if (blocklist.includes(hostname)) return false;

    // Block `.local` and `.internal`
    if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;

    // Optional: block basic private IP ranges (IPv4)
    // 10.0.0.0/8
    if (hostname.startsWith('10.')) return false;
    // 192.168.0.0/16
    if (hostname.startsWith('192.168.')) return false;
    // 172.16.0.0/12
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)) return false;

    return true;
  } catch (e) {
    return false;
  }
};

const safeUrlSchema = z.string().url('Must be a valid URL').refine(isSafeUrl, {
  message: 'Invalid or unsafe URL provided',
});

export const adminListMonitorsSchema = z.object({
  jurisdiction: blogJurisdictionSchema.optional(),
  authorityType: blogAuthorityTypeSchema.optional(),
  sourceType: blogSourceTypeSchema.optional(),
  monitoringMethod: blogMonitoringMethodSchema.optional(),
  status: blogMonitorStatusSchema.optional(),
  isActive: z.boolean().optional(),
  search: z.string().optional(),
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(20),
});

export const adminGetMonitorSchema = z.object({
  id: z.string().min(1),
});

export const adminCreateMonitorSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  description: z.string().optional().nullable(),
  jurisdiction: blogJurisdictionSchema,
  countryLabel: z.string().optional().nullable(),
  authorityType: blogAuthorityTypeSchema,
  sourceType: blogSourceTypeSchema,
  monitoringMethod: blogMonitoringMethodSchema.default('MANUAL'),
  baseUrl: safeUrlSchema,
  feedUrl: z.union([safeUrlSchema, z.literal(''), z.null()]).optional(),
  topics: z.array(z.string()).max(20).default([]),
  keywords: z.array(z.string()).max(50).default([]),
  status: blogMonitorStatusSchema.default('NEEDS_VERIFICATION'),
  isActive: z.boolean().default(false),
  maxItemsPerRun: z.number().min(1).max(100).default(20),
  fetchTimeoutMs: z.number().min(3000).max(60000).default(15000),
  respectRobots: z.boolean().default(true),
  notes: z.string().optional().nullable(),
});

export const adminUpdateMonitorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(2).optional(),
  description: z.string().optional().nullable(),
  jurisdiction: blogJurisdictionSchema.optional(),
  countryLabel: z.string().optional().nullable(),
  authorityType: blogAuthorityTypeSchema.optional(),
  sourceType: blogSourceTypeSchema.optional(),
  monitoringMethod: blogMonitoringMethodSchema.optional(),
  baseUrl: safeUrlSchema.optional(),
  feedUrl: z.union([safeUrlSchema, z.literal(''), z.null()]).optional(),
  topics: z.array(z.string()).max(20).optional(),
  keywords: z.array(z.string()).max(50).optional(),
  maxItemsPerRun: z.number().min(1).max(100).optional(),
  fetchTimeoutMs: z.number().min(3000).max(60000).optional(),
  respectRobots: z.boolean().optional(),
  notes: z.string().optional().nullable(),
});

export const adminSetMonitorStatusSchema = z.object({
  id: z.string().min(1),
  status: blogMonitorStatusSchema,
  isActive: z.boolean().optional(),
});

export const adminVerifyMonitorSchema = z.object({
  id: z.string().min(1),
  notes: z.string().optional().nullable(),
});

export const adminDeleteMonitorSchema = z.object({
  id: z.string().min(1),
});

export const adminListSourceItemsSchema = z.object({
  monitorId: z.string().optional(),
  jurisdiction: blogJurisdictionSchema.optional(),
  authorityType: blogAuthorityTypeSchema.optional(),
  sourceType: blogSourceTypeSchema.optional(),
  status: blogSourceItemStatusSchema.optional(),
  search: z.string().optional(),
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(20),
});

export const adminGetSourceItemSchema = z.object({
  id: z.string().min(1),
});

export const adminDismissSourceItemSchema = z.object({
  id: z.string().min(1),
  reason: z.string().min(1),
});

export const adminRunMonitorNowSchema = z.object({
  monitorId: z.string().min(1),
});

export const adminListDiscoveryRunsSchema = z.object({
  monitorId: z.string().optional(),
  status: blogDiscoveryRunStatusSchema.optional(),
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(20),
});

export const adminScoreSourceItemSchema = z.object({
  sourceItemId: z.string().min(1),
  minScore: z.number().min(0).max(100).optional(),
});

export const adminScoreEligibleSourceItemsSchema = z.object({
  minScore: z.number().min(0).max(100).optional(),
  limit: z.number().min(1).max(100).optional(),
  jurisdiction: blogJurisdictionSchema.optional(),
  monitorId: z.string().optional(),
});

export const adminListSuggestionsSchema = z
  .object({
    status: blogSuggestionStatusSchema.optional(),
    priority: blogSuggestionPrioritySchema.optional(),
    jurisdiction: blogJurisdictionSchema.optional(),
    authorityType: blogAuthorityTypeSchema.optional(),
    category: z.string().optional(),
    articleType: blogArticleTypeSchema.optional(),
    search: z.string().optional(),
    sortBy: z.enum(['relevanceScore', 'score', 'createdAt']).optional().default('score'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
    minScore: z.number().min(0).max(100).optional(),
    maxScore: z.number().min(0).max(100).optional(),
    page: z.number().min(1).default(1),
    limit: z.number().min(1).max(100).default(20),
  })
  .refine(
    (data) => {
      if (data.minScore !== undefined && data.maxScore !== undefined) {
        return data.minScore <= data.maxScore;
      }
      return true;
    },
    {
      message: 'minScore must be less than or equal to maxScore',
      path: ['minScore'],
    }
  );

export const adminGetSuggestionSchema = z.object({
  id: z.string().min(1),
});

export const adminDismissSuggestionSchema = z.object({
  id: z.string().min(1),
  reason: z.string().min(5),
});

export const adminApproveSuggestionForDraftSchema = z.object({
  id: z.string().min(1),
});

export const adminMarkSuggestionNeedsMoreSourcesSchema = z.object({
  id: z.string().min(1),
  reason: z.string().optional(),
});

export const adminDeleteSuggestionSchema = z.object({
  id: z.string().min(1),
});

export const adminCreateDraftFromSuggestionSchema = z.object({
  suggestionId: z.string().min(1),
});

export const adminGenerateAiDraftSchema = z.object({
  blogPostId: z.string().min(1),
});

export const adminRunBlogVerificationSchema = z.object({
  blogPostId: z.string().min(1),
  runType: blogVerificationRunTypeSchema.optional().default('MANUAL'),
  useAiReview: z.boolean().optional().default(false),
});

export const adminListBlogVerificationRunsSchema = z.object({
  blogPostId: z.string().optional(),
  status: blogVerificationStatusSchema.optional(),
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(20),
});

export const adminGetBlogVerificationRunSchema = z.object({
  id: z.string().min(1),
});

export const adminGetLatestBlogVerificationSchema = z.object({
  blogPostId: z.string().min(1),
});

export const adminListEditorialDigestsSchema = z.object({
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(20),
});

export const adminGetEditorialDigestSchema = z.object({
  id: z.string().min(1),
});

export const adminGenerateEditorialDigestSchema = z.object({
  force: z.boolean().optional().default(false),
  periodStart: z.date().optional(),
  periodEnd: z.date().optional(),
});

export const adminListEditorialTriageRunsSchema = z.object({
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(20),
});

export const adminGetEditorialTriageRunSchema = z.object({
  id: z.string().min(1),
});

export const adminListResearchPackVersionsSchema = z.object({
  blogPostId: z.string().optional(),
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(20),
});

export const adminGetResearchPackSchema = z.object({
  id: z.string().min(1),
});

export const adminReviewResearchPackSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['REVIEWED', 'REJECTED']),
  note: z.string().optional(),
});

export const adminListFreshnessReviewsSchema = z.object({
  blogPostId: z.string().optional(),
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(20),
});

export const adminGetFreshnessReviewSchema = z.object({
  id: z.string().min(1),
});

export const adminListRevisionRequestsSchema = z.object({
  blogPostId: z.string().optional(),
  status: z.enum(['PENDING_REVIEW', 'ASSIGNED', 'ACCEPTED', 'RESOLVED', 'DISMISSED']).optional(),
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(20),
});

export const adminGetRevisionRequestSchema = z.object({
  id: z.string().min(1),
});

export const adminAssignRevisionRequestSchema = z.object({
  id: z.string().min(1),
  assignedToId: z.string().min(1),
});

export const adminAcceptRevisionRequestSchema = z.object({
  id: z.string().min(1),
});

export const adminStartRevisionRequestSchema = z.object({
  id: z.string().min(1),
});

export const adminResolveRevisionRequestSchema = z.object({
  id: z.string().min(1),
  resolutionNotes: z.string().min(1),
});

export const adminDismissRevisionRequestSchema = z.object({
  id: z.string().min(1),
  reason: z.string().min(1),
});

export const adminListContentOpsAlertsSchema = z.object({
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'IGNORED']).optional(),
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(20),
});

export const adminGetContentOpsAlertSchema = z.object({
  id: z.string().min(1),
});

export const adminAcknowledgeContentOpsAlertSchema = z.object({
  id: z.string().min(1),
});

export const adminResolveContentOpsAlertSchema = z.object({
  id: z.string().min(1),
  resolutionNotes: z.string().min(1),
});

export const adminIgnoreContentOpsAlertSchema = z.object({
  id: z.string().min(1),
  reason: z.string().min(1),
});
