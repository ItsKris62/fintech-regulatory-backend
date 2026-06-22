import { z } from 'zod';
import {
  BlogJurisdiction,
  BlogAuthorityType,
  BlogMonitoringMethod,
  BlogMonitorStatus,
  BlogSourceType,
  BlogSourceItemStatus,
  BlogDiscoveryRunStatus,
} from '@prisma/client';

export const blogJurisdictionSchema = z.nativeEnum(BlogJurisdiction);
export const blogAuthorityTypeSchema = z.nativeEnum(BlogAuthorityType);
export const blogMonitoringMethodSchema = z.nativeEnum(BlogMonitoringMethod);
export const blogMonitorStatusSchema = z.nativeEnum(BlogMonitorStatus);
export const blogSourceTypeSchema = z.nativeEnum(BlogSourceType);
export const blogSourceItemStatusSchema = z.nativeEnum(BlogSourceItemStatus);
export const blogDiscoveryRunStatusSchema = z.nativeEnum(BlogDiscoveryRunStatus);

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

