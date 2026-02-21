import { z } from 'zod';
import { phoneSchema } from '@/utils/validation';

/**
 * Organization Schemas
 * 
 * Zod validation schemas for organization management.
 */

/**
 * Create organization
 * 
 * @example
 * {
 *   name: "FinTech Solutions Ltd",
 *   type: "STARTUP",
 *   registrationNumber: "PVT-123456",
 *   industry: "Financial Technology",
 *   contactEmail: "info@fintech.co.ke",
 *   contactPhone: "+254700123456",
 *   address: "Nairobi, Kenya"
 * }
 */
export const createOrganizationSchema = z.object({
  name: z.string().min(2).max(200),
  type: z.enum(['REGULATOR', 'STARTUP', 'ENTERPRISE', 'BANK', 'TELECOM', 'INSURANCE', 'OTHER']),
  registrationNumber: z.string().min(1).max(100).optional(),
  industry: z.string().min(1).max(100).optional(),
  contactEmail: z.string().email(),
  contactPhone: phoneSchema.optional(),
  address: z.string().optional(),
  website: z.string().url().optional(),
  description: z.string().max(1000).optional(),
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

/**
 * Update organization
 * 
 * All fields optional (partial update)
 */
export const updateOrganizationSchema = z.object({
  id: z.string(),
  name: z.string().min(2).max(200).optional(),
  type: z.enum(['REGULATOR', 'STARTUP', 'ENTERPRISE', 'BANK', 'TELECOM', 'INSURANCE', 'OTHER']).optional(),
  registrationNumber: z.string().min(1).max(100).optional(),
  industry: z.string().min(1).max(100).optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: phoneSchema.optional(),
  address: z.string().optional(),
  website: z.string().url().optional(),
  description: z.string().max(1000).optional(),
});

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

/**
 * Get organization by ID
 */
export const getOrganizationSchema = z.object({
  id: z.string(),
});

export type GetOrganizationInput = z.infer<typeof getOrganizationSchema>;

/**
 * List organizations with pagination
 */
export const listOrganizationsSchema = z.object({
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(10),
  type: z.enum(['REGULATOR', 'STARTUP', 'ENTERPRISE', 'BANK', 'TELECOM', 'INSURANCE', 'OTHER']).optional(),
  search: z.string().optional(),
});

export type ListOrganizationsInput = z.infer<typeof listOrganizationsSchema>;

/**
 * Add member to organization
 */
export const addMemberSchema = z.object({
  organizationId: z.string(),
  userId: z.string(),
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']).default('MEMBER'),
});

export type AddMemberInput = z.infer<typeof addMemberSchema>;

/**
 * Remove member from organization
 */
export const removeMemberSchema = z.object({
  organizationId: z.string(),
  userId: z.string(),
});

export type RemoveMemberInput = z.infer<typeof removeMemberSchema>;

/**
 * Get organization members
 */
export const getMembersSchema = z.object({
  organizationId: z.string(),
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(20),
});

export type GetMembersInput = z.infer<typeof getMembersSchema>;

/**
 * Delete organization
 */
export const deleteOrganizationSchema = z.object({
  id: z.string(),
});

export type DeleteOrganizationInput = z.infer<typeof deleteOrganizationSchema>;