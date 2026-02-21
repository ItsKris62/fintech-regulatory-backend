/**
 * Organization Module Utilities
 * Helper functions for organization operations
 */

import { z } from 'zod';
import type {
  Organization,
  OrganizationWithMembers,
  OrganizationMember,
  OrganizationSettings,
  MemberRole,
} from './organization.types';

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * Organization type enum
 */
const organizationTypeEnum = z.enum([
  'FINTECH',
  'BANK',
  'INSURANCE',
  'SACCO',
  'MFI',
  'PAYMENT_PROVIDER',
  'LENDING',
  'INVESTMENT',
  'REGULATOR',
  'OTHER',
]);

/**
 * Member role enum
 */
const memberRoleEnum = z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']);

/**
 * Create organization validation schema
 */
export const createOrganizationSchema = z.object({
  name: z
    .string()
    .min(2, 'Organization name must be at least 2 characters')
    .max(100, 'Organization name must be less than 100 characters'),
  type: organizationTypeEnum,
  description: z.string().max(500).optional(),
  website: z.string().url('Invalid website URL').optional().nullable(),
  address: z.string().max(200).optional(),
  phone: z
    .string()
    .regex(/^\+?[1-9]\d{6,14}$/, 'Invalid phone number')
    .optional()
    .nullable(),
  email: z.string().email('Invalid email').optional().nullable(),
  registrationNumber: z.string().max(50).optional(),
  regulatoryAreas: z.array(z.string()).optional(),
});

/**
 * Update organization validation schema
 */
export const updateOrganizationSchema = z.object({
  name: z
    .string()
    .min(2, 'Organization name must be at least 2 characters')
    .max(100, 'Organization name must be less than 100 characters')
    .optional(),
  type: organizationTypeEnum.optional(),
  description: z.string().max(500).optional().nullable(),
  website: z.string().url('Invalid website URL').optional().nullable(),
  logoUrl: z.string().url('Invalid logo URL').optional().nullable(),
  address: z.string().max(200).optional().nullable(),
  phone: z
    .string()
    .regex(/^\+?[1-9]\d{6,14}$/, 'Invalid phone number')
    .optional()
    .nullable(),
  email: z.string().email('Invalid email').optional().nullable(),
  registrationNumber: z.string().max(50).optional().nullable(),
});

/**
 * Update settings validation schema
 */
export const updateSettingsSchema = z.object({
  compliance: z.object({
    regulatoryAreas: z.array(z.string()).optional(),
    autoComplianceCheck: z.boolean().optional(),
    deadlineReminders: z.boolean().optional(),
    reminderDays: z.array(z.number().int().positive()).optional(),
  }).optional(),
  notifications: z.object({
    emailNotifications: z.boolean().optional(),
    weeklyReport: z.boolean().optional(),
    complianceAlerts: z.boolean().optional(),
  }).optional(),
  access: z.object({
    allowMemberInvites: z.boolean().optional(),
    requireApproval: z.boolean().optional(),
    defaultMemberRole: memberRoleEnum.optional(),
  }).optional(),
  branding: z.object({
    primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().nullable(),
    customLogo: z.boolean().optional(),
  }).optional(),
});

/**
 * Add member validation schema
 */
export const addMemberSchema = z.object({
  email: z.string().email('Invalid email address'),
  role: memberRoleEnum.refine(
    (role) => role !== 'OWNER',
    'Cannot invite someone as owner'
  ),
  sendInvite: z.boolean().default(true),
});

/**
 * Update member role validation schema
 */
export const updateMemberRoleSchema = z.object({
  role: memberRoleEnum.refine(
    (role) => role !== 'OWNER',
    'Cannot change role to owner (use transfer ownership instead)'
  ),
});

/**
 * Member filters validation schema
 */
export const memberFiltersSchema = z.object({
  role: memberRoleEnum.optional(),
  search: z.string().optional(),
  page: z.number().int().positive().default(1),
  limit: z.number().int().positive().max(100).default(20),
});

// ============================================================================
// Data Transformation Utilities
// ============================================================================

/**
 * Convert database organization to Organization type
 */
export function toOrganization(dbOrg: {
  id: string;
  name: string;
  type: string;
  status: string;
  description: string | null;
  website: string | null;
  logoUrl: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  registrationNumber: string | null;
  ownerId: string;
  settings: any;
  createdAt: Date;
  updatedAt: Date;
}): Organization {
  return {
    id: dbOrg.id,
    name: dbOrg.name,
    type: dbOrg.type as Organization['type'],
    status: dbOrg.status as Organization['status'],
    description: dbOrg.description,
    website: dbOrg.website,
    logoUrl: dbOrg.logoUrl,
    address: dbOrg.address,
    phone: dbOrg.phone,
    email: dbOrg.email,
    registrationNumber: dbOrg.registrationNumber,
    ownerId: dbOrg.ownerId,
    settings: parseSettings(dbOrg.settings),
    createdAt: dbOrg.createdAt,
    updatedAt: dbOrg.updatedAt,
  };
}

/**
 * Convert database organization with members to OrganizationWithMembers
 */
export function toOrganizationWithMembers(
  dbOrg: any,
  members: OrganizationMember[]
): OrganizationWithMembers {
  return {
    ...toOrganization(dbOrg),
    members,
    memberCount: members.length,
  };
}

/**
 * Convert database member to OrganizationMember
 */
export function toOrganizationMember(dbMember: {
  id: string;
  userId: string;
  organizationId: string;
  role: string;
  joinedAt: Date;
  invitedBy: string | null;
  user: {
    id: string;
    name: string;
    email: string;
    avatarUrl?: string | null;
    lastLoginAt?: Date | null;
  };
}): OrganizationMember {
  return {
    id: dbMember.id,
    userId: dbMember.userId,
    organizationId: dbMember.organizationId,
    role: dbMember.role as MemberRole,
    joinedAt: dbMember.joinedAt,
    invitedBy: dbMember.invitedBy,
    user: {
      id: dbMember.user.id,
      name: dbMember.user.name,
      email: dbMember.user.email,
      avatarUrl: dbMember.user.avatarUrl || null,
      lastLoginAt: dbMember.user.lastLoginAt || null,
    },
  };
}

// ============================================================================
// Settings Utilities
// ============================================================================

/**
 * Default organization settings
 */
export const defaultSettings: OrganizationSettings = {
  compliance: {
    regulatoryAreas: [],
    autoComplianceCheck: true,
    deadlineReminders: true,
    reminderDays: [30, 14, 7, 3, 1],
  },
  notifications: {
    emailNotifications: true,
    weeklyReport: true,
    complianceAlerts: true,
  },
  access: {
    allowMemberInvites: false,
    requireApproval: true,
    defaultMemberRole: 'MEMBER',
  },
  branding: {
    primaryColor: null,
    customLogo: false,
  },
};

/**
 * Parse settings from database JSON
 */
export function parseSettings(settings: any): OrganizationSettings {
  if (!settings) {
    return { ...defaultSettings };
  }
  
  try {
    const parsed = typeof settings === 'string' ? JSON.parse(settings) : settings;
    return mergeSettings(defaultSettings, parsed);
  } catch {
    return { ...defaultSettings };
  }
}

/**
 * Deep merge settings with defaults
 */
export function mergeSettings(
  defaults: OrganizationSettings,
  updates: Partial<OrganizationSettings>
): OrganizationSettings {
  return {
    compliance: {
      ...defaults.compliance,
      ...(updates.compliance || {}),
    },
    notifications: {
      ...defaults.notifications,
      ...(updates.notifications || {}),
    },
    access: {
      ...defaults.access,
      ...(updates.access || {}),
    },
    branding: {
      ...defaults.branding,
      ...(updates.branding || {}),
    },
  };
}

// ============================================================================
// Permission Utilities
// ============================================================================

/**
 * Role hierarchy for permission checks
 */
export const ROLE_HIERARCHY: Record<MemberRole, number> = {
  VIEWER: 1,
  MEMBER: 2,
  ADMIN: 3,
  OWNER: 4,
};

/**
 * Check if a role has at least the required permission level
 */
export function hasPermission(
  userRole: MemberRole,
  requiredRole: MemberRole
): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole];
}

/**
 * Check if user can modify another user's role
 */
export function canModifyRole(
  modifierRole: MemberRole,
  targetCurrentRole: MemberRole,
  targetNewRole: MemberRole
): boolean {
  // Only owner and admin can modify roles
  if (!hasPermission(modifierRole, 'ADMIN')) {
    return false;
  }
  
  // Cannot modify owner's role
  if (targetCurrentRole === 'OWNER') {
    return false;
  }
  
  // Admin cannot promote to owner
  if (modifierRole === 'ADMIN' && targetNewRole === 'OWNER') {
    return false;
  }
  
  // Admin cannot modify other admins
  if (modifierRole === 'ADMIN' && targetCurrentRole === 'ADMIN') {
    return false;
  }
  
  return true;
}

/**
 * Get role display name
 */
export function getRoleDisplayName(role: MemberRole): string {
  const names: Record<MemberRole, string> = {
    OWNER: 'Owner',
    ADMIN: 'Administrator',
    MEMBER: 'Member',
    VIEWER: 'Viewer',
  };
  return names[role];
}

/**
 * Get role description
 */
export function getRoleDescription(role: MemberRole): string {
  const descriptions: Record<MemberRole, string> = {
    OWNER: 'Full control over organization settings, billing, and can delete the organization',
    ADMIN: 'Can manage members, settings, and all content',
    MEMBER: 'Can create and manage their own content',
    VIEWER: 'Can only view content, cannot create or edit',
  };
  return descriptions[role];
}

// ============================================================================
// Token Generation
// ============================================================================

/**
 * Generate invitation token
 */
export function generateInvitationToken(): string {
  return `inv_${crypto.randomUUID().replace(/-/g, '')}`;
}

// ============================================================================
// Email Templates
// ============================================================================

/**
 * Generate member invitation email
 */
export function generateInvitationEmail(
  organizationName: string,
  inviterName: string,
  role: MemberRole,
  inviteUrl: string
): { subject: string; text: string; html: string } {
  const roleDisplay = getRoleDisplayName(role);
  
  return {
    subject: `You've been invited to join ${organizationName} on SheriaBot`,
    text: `
Hi there,

${inviterName} has invited you to join ${organizationName} as a ${roleDisplay} on SheriaBot.

Click the link below to accept the invitation:
${inviteUrl}

This invitation expires in 7 days.

If you didn't expect this invitation, you can safely ignore this email.

Best regards,
The SheriaBot Team
    `.trim(),
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <h2 style="color: #2563eb;">You're Invited!</h2>
    <p>Hi there,</p>
    <p><strong>${inviterName}</strong> has invited you to join <strong>${organizationName}</strong> as a <strong>${roleDisplay}</strong> on SheriaBot.</p>
    <p style="text-align: center; margin: 30px 0;">
      <a href="${inviteUrl}" 
         style="background-color: #2563eb; color: white; padding: 12px 24px; 
                text-decoration: none; border-radius: 6px; display: inline-block;">
        Accept Invitation
      </a>
    </p>
    <p style="color: #666; font-size: 14px;">
      This invitation expires in 7 days.
    </p>
    <p style="color: #666; font-size: 14px;">
      If you didn't expect this invitation, you can safely ignore this email.
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

/**
 * Generate member removed notification email
 */
export function generateMemberRemovedEmail(
  memberName: string,
  organizationName: string
): { subject: string; text: string; html: string } {
  return {
    subject: `You've been removed from ${organizationName}`,
    text: `
Hi ${memberName},

You have been removed from ${organizationName} on SheriaBot.

You no longer have access to the organization's policies, documents, or other resources.

If you believe this was a mistake, please contact the organization administrator.

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
    <h2 style="color: #dc2626;">Membership Removed</h2>
    <p>Hi ${memberName},</p>
    <p>You have been removed from <strong>${organizationName}</strong> on SheriaBot.</p>
    <p>You no longer have access to the organization's policies, documents, or other resources.</p>
    <p style="color: #666; font-size: 14px;">
      If you believe this was a mistake, please contact the organization administrator.
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

/**
 * Generate role change notification email
 */
export function generateRoleChangeEmail(
  memberName: string,
  organizationName: string,
  oldRole: MemberRole,
  newRole: MemberRole
): { subject: string; text: string; html: string } {
  const oldRoleDisplay = getRoleDisplayName(oldRole);
  const newRoleDisplay = getRoleDisplayName(newRole);
  
  return {
    subject: `Your role in ${organizationName} has changed`,
    text: `
Hi ${memberName},

Your role in ${organizationName} has been changed from ${oldRoleDisplay} to ${newRoleDisplay}.

${getRoleDescription(newRole)}

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
    <h2 style="color: #2563eb;">Role Changed</h2>
    <p>Hi ${memberName},</p>
    <p>Your role in <strong>${organizationName}</strong> has been changed from <strong>${oldRoleDisplay}</strong> to <strong>${newRoleDisplay}</strong>.</p>
    <p style="background-color: #f3f4f6; padding: 15px; border-radius: 6px;">
      <strong>${newRoleDisplay}</strong>: ${getRoleDescription(newRole)}
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

/**
 * Generate ownership transfer email
 */
export function generateOwnershipTransferEmail(
  newOwnerName: string,
  previousOwnerName: string,
  organizationName: string,
  isNewOwner: boolean
): { subject: string; text: string; html: string } {
  if (isNewOwner) {
    return {
      subject: `You are now the owner of ${organizationName}`,
      text: `
Hi ${newOwnerName},

${previousOwnerName} has transferred ownership of ${organizationName} to you.

As the owner, you have full control over the organization including:
- Managing all members and their roles
- Updating organization settings
- Managing billing and subscriptions
- Deleting the organization

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
    <h2 style="color: #2563eb;">Ownership Transferred</h2>
    <p>Hi ${newOwnerName},</p>
    <p><strong>${previousOwnerName}</strong> has transferred ownership of <strong>${organizationName}</strong> to you.</p>
    <p>As the owner, you have full control over the organization.</p>
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
  
  return {
    subject: `You've transferred ownership of ${organizationName}`,
    text: `
Hi ${previousOwnerName},

You have successfully transferred ownership of ${organizationName} to ${newOwnerName}.

Your role has been changed to Administrator. You still have access to manage the organization, but you can no longer delete it or transfer ownership.

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
    <h2 style="color: #2563eb;">Ownership Transferred</h2>
    <p>Hi ${previousOwnerName},</p>
    <p>You have successfully transferred ownership of <strong>${organizationName}</strong> to <strong>${newOwnerName}</strong>.</p>
    <p>Your role has been changed to Administrator.</p>
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
