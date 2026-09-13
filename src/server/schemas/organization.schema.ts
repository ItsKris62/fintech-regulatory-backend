import { z } from 'zod';
import { phoneSchema } from '@/utils/validation';
import { AUDITED_JURISDICTIONS } from '@/config/jurisdictions.config';

export const homeJurisdictionCodeSchema = z.enum(AUDITED_JURISDICTIONS);

/**
 * Organization Schemas
 *
 * Zod validation schemas for organization management.
 */

/**
 * Create organization
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
  homeJurisdictionCode: homeJurisdictionCodeSchema,
  enabledJurisdictions: z.array(homeJurisdictionCodeSchema).optional(),
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
  homeJurisdictionCode: homeJurisdictionCodeSchema.optional(),
  homeJurisdictionReason: z.string().max(500).optional(),
  enabledJurisdictions: z.array(homeJurisdictionCodeSchema).optional(),
  needsCountryConfirmation: z.boolean().optional(),
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

/**
 * Update organization settings (settings page  -  uses ctx.user.organizationId, no id param)
 *
 * All fields optional (partial update). Includes contact information fields.
 */
export const updateOrganizationSettingsSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  registrationNumber: z.string().max(100).optional(),
  industry: z.string().max(100).optional(),
  website: z.union([z.string().url('Invalid URL format'), z.literal('')]).optional(),
  address: z.string().max(500).optional(),
  contactPerson: z.string().max(200).optional(),
  contactPosition: z.string().max(200).optional(),
  contactEmail: z.union([z.string().email('Invalid email format'), z.literal('')]).optional(),
  contactPhone: z.union([phoneSchema, z.literal('')]).optional(),
  homeJurisdictionCode: homeJurisdictionCodeSchema.optional(),
  homeJurisdictionReason: z.string().max(500).optional(),
  enabledJurisdictions: z.array(homeJurisdictionCodeSchema).optional(),
});

export type UpdateOrganizationSettingsInput = z.infer<typeof updateOrganizationSettingsSchema>;

export const confirmCountrySchema = z.object({
  organizationId: z.string().optional(),
  homeJurisdictionCode: homeJurisdictionCodeSchema,
  enabledJurisdictions: z.array(homeJurisdictionCodeSchema).optional(),
});

export type ConfirmCountryInput = z.infer<typeof confirmCountrySchema>;

export const updateEnabledJurisdictionsSchema = z.object({
  organizationId: z.string().optional(),
  enabledJurisdictions: z.array(homeJurisdictionCodeSchema),
});

export type UpdateEnabledJurisdictionsInput = z.infer<typeof updateEnabledJurisdictionsSchema>;

export const scheduleCountryReplacementSchema = z.object({
  organizationId: z.string().optional(),
  fromJurisdiction: homeJurisdictionCodeSchema,
  toJurisdiction: homeJurisdictionCodeSchema,
});

export type ScheduleCountryReplacementInput = z.infer<typeof scheduleCountryReplacementSchema>;

export const cancelCountryReplacementSchema = z.object({
  organizationId: z.string().optional(),
});

export type CancelCountryReplacementInput = z.infer<typeof cancelCountryReplacementSchema>;

/**
 * Shared DTO for Organization Members
 */
export interface OrganizationMemberDTO {
  id: string;
  fullName: string;
  email: string;
  /**
   * @deprecated Use platformRole or orgRole instead
   */
  role: string;
  platformRole: string;
  orgRole: string;
  joinedAt: Date;
  [key: string]: any;
}
