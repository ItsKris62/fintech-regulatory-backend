/**
 * Organization Module Types
 * Type definitions for organization management operations
 */


// ============================================================================
// Organization Types
// ============================================================================

/**
 * Organization type/category
 */
export type OrganizationType =
  | 'FINTECH'
  | 'BANK'
  | 'INSURANCE'
  | 'SACCO'
  | 'MFI' // Microfinance Institution
  | 'PAYMENT_PROVIDER'
  | 'LENDING'
  | 'INVESTMENT'
  | 'REGULATOR'
  | 'OTHER';

/**
 * Organization status
 */
export type OrganizationStatus =
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'PENDING_VERIFICATION'
  | 'DELETED';

/**
 * Member role within an organization
 */
export type MemberRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

/**
 * Organization data
 */
export interface Organization {
  id: string;
  name: string;
  type: OrganizationType;
  status: OrganizationStatus;
  description: string | null;
  website: string | null;
  logoUrl: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  registrationNumber: string | null;
  ownerId: string;
  settings: OrganizationSettings;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Organization with members
 */
export interface OrganizationWithMembers extends Organization {
  members: OrganizationMember[];
  memberCount: number;
}

/**
 * Organization member
 */
export interface OrganizationMember {
  id: string;
  userId: string;
  organizationId: string;
  role: MemberRole;
  joinedAt: Date;
  invitedBy: string | null;
  user: {
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
    lastLoginAt: Date | null;
  };
}

/**
 * Organization settings stored as JSON
 */
export interface OrganizationSettings {
  // Compliance settings
  compliance: {
    regulatoryAreas: string[];
    autoComplianceCheck: boolean;
    deadlineReminders: boolean;
    reminderDays: number[];
  };
  
  // Notification settings
  notifications: {
    emailNotifications: boolean;
    weeklyReport: boolean;
    complianceAlerts: boolean;
  };
  
  // Access settings
  access: {
    allowMemberInvites: boolean;
    requireApproval: boolean;
    defaultMemberRole: MemberRole;
  };
  
  // Branding
  branding: {
    primaryColor: string | null;
    customLogo: boolean;
  };
}

/**
 * Default organization settings
 */
export const DEFAULT_ORGANIZATION_SETTINGS: OrganizationSettings = {
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

// ============================================================================
// Input Types
// ============================================================================

/**
 * Create organization input
 */
export interface CreateOrganizationInput {
  name: string;
  type: OrganizationType;
  description?: string;
  website?: string;
  address?: string;
  phone?: string;
  email?: string;
  registrationNumber?: string;
  regulatoryAreas?: string[];
}

/**
 * Update organization input
 */
export interface UpdateOrganizationInput {
  name?: string;
  type?: OrganizationType;
  description?: string;
  website?: string;
  logoUrl?: string;
  address?: string;
  phone?: string;
  email?: string;
  registrationNumber?: string;
}

/**
 * Update organization settings input
 */
export interface UpdateSettingsInput {
  compliance?: Partial<OrganizationSettings['compliance']>;
  notifications?: Partial<OrganizationSettings['notifications']>;
  access?: Partial<OrganizationSettings['access']>;
  branding?: Partial<OrganizationSettings['branding']>;
}

/**
 * Add member input
 */
export interface AddMemberInput {
  email: string;
  role: MemberRole;
  sendInvite?: boolean;
}

/**
 * Invitation data
 */
export interface Invitation {
  id: string;
  organizationId: string;
  email: string;
  role: MemberRole;
  invitedBy: string;
  token: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  createdAt: Date;
}

// ============================================================================
// Stats Types
// ============================================================================

/**
 * Organization statistics
 */
export interface OrganizationStats {
  // Member stats
  totalMembers: number;
  activeMembers: number;
  membersByRole: Record<MemberRole, number>;
  
  // Content stats
  totalPolicies: number;
  publishedPolicies: number;
  draftPolicies: number;
  totalDocuments: number;
  totalQueries: number;
  
  // Usage stats
  storageUsedBytes: number;
  storageQuotaBytes: number;
  aiTokensUsedThisMonth: number;
  aiTokensQuota: number;
  
  // Compliance stats
  complianceScore: number | null;
  pendingRequirements: number;
  completedRequirements: number;
  upcomingDeadlines: number;
  
  // Activity
  lastActivityAt: Date | null;
  createdAt: Date;
}

/**
 * Member activity stats
 */
export interface MemberActivityStats {
  userId: string;
  userName: string;
  policiesCreated: number;
  queriesSubmitted: number;
  documentsUploaded: number;
  lastActiveAt: Date | null;
}

// ============================================================================
// Result Types
// ============================================================================

/**
 * Add member result
 */
export interface AddMemberResult {
  success: boolean;
  member?: OrganizationMember;
  invitation?: Invitation;
  message: string;
}

/**
 * Remove member result
 */
export interface RemoveMemberResult {
  success: boolean;
  message: string;
}

/**
 * Transfer ownership result
 */
export interface TransferOwnershipResult {
  success: boolean;
  previousOwner: { id: string; newRole: MemberRole };
  newOwner: { id: string; role: MemberRole };
  message: string;
}

/**
 * Delete organization result
 */
export interface DeleteOrganizationResult {
  success: boolean;
  archivedPolicies: number;
  archivedDocuments: number;
  removedMembers: number;
  message: string;
}

// ============================================================================
// Filter Types
// ============================================================================

/**
 * Organization list filters
 */
export interface OrganizationFilters {
  type?: OrganizationType;
  status?: OrganizationStatus;
  search?: string;
  page?: number;
  limit?: number;
}

/**
 * Member list filters
 */
export interface MemberFilters {
  role?: MemberRole;
  search?: string;
  page?: number;
  limit?: number;
}

/**
 * Paginated members result
 */
export interface PaginatedMembers {
  members: OrganizationMember[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ============================================================================
// Error Types
// ============================================================================

export class OrganizationError extends Error {
  constructor(
    message: string,
    public code: OrganizationErrorCode,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = 'OrganizationError';
  }
}

export type OrganizationErrorCode =
  | 'ORGANIZATION_NOT_FOUND'
  | 'MEMBER_NOT_FOUND'
  | 'USER_NOT_FOUND'
  | 'ALREADY_MEMBER'
  | 'NOT_MEMBER'
  | 'INSUFFICIENT_PERMISSIONS'
  | 'CANNOT_REMOVE_OWNER'
  | 'CANNOT_REMOVE_LAST_ADMIN'
  | 'INVALID_ROLE'
  | 'INVITATION_EXPIRED'
  | 'INVITATION_NOT_FOUND'
  | 'ORGANIZATION_LIMIT_REACHED'
  | 'MEMBER_LIMIT_REACHED'
  | 'RATE_LIMIT_EXCEEDED';

// ============================================================================
// Constants
// ============================================================================

export const ORGANIZATION_CONSTANTS = {
  // Limits
  MAX_MEMBERS_FREE: 5,
  MAX_MEMBERS_PRO: 25,
  MAX_MEMBERS_ENTERPRISE: 100,
  MAX_ORGANIZATIONS_PER_USER: 5,
  
  // Cache settings
  ORG_CACHE_TTL: 5 * 60, // 5 minutes
  MEMBERS_CACHE_TTL: 2 * 60, // 2 minutes
  STATS_CACHE_TTL: 10 * 60, // 10 minutes
  
  // Invitation settings
  INVITATION_EXPIRY_DAYS: 7,
  
  // Redis keys
  REDIS_KEYS: {
    ORGANIZATION: 'org:',
    MEMBERS: 'org:members:',
    STATS: 'org:stats:',
    INVITATION: 'org:invitation:',
  },
  
  // Role hierarchy (higher number = more permissions)
  ROLE_HIERARCHY: {
    VIEWER: 1,
    MEMBER: 2,
    ADMIN: 3,
    OWNER: 4,
  } as const,
} as const;

/**
 * Check if role has sufficient permissions
 */
export function hasPermission(
  userRole: MemberRole,
  requiredRole: MemberRole
): boolean {
  return (
    ORGANIZATION_CONSTANTS.ROLE_HIERARCHY[userRole] >=
    ORGANIZATION_CONSTANTS.ROLE_HIERARCHY[requiredRole]
  );
}
