/**
 * Organization Module
 * Handles all organization management business logic
 * 
 * Operations:
 * - Organization CRUD
 * - Member management (add, remove, update roles)
 * - Settings management
 * - Statistics and analytics
 * - Ownership transfer
 * - Invitations
 */

import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { mailer as _mailer } from '@/lib/email/mailer.service';
import { sendEmail } from '@/lib/email/client';
import { logger } from '@/utils/logger';
import { config } from '@/config';
import {
  toOrganization,
  toOrganizationMember,
  parseSettings,
  mergeSettings,
  defaultSettings,
  hasPermission,
  canModifyRole,
  generateInvitationToken,
  generateInvitationEmail,
  generateMemberRemovedEmail,
  generateRoleChangeEmail,
  generateOwnershipTransferEmail,
  createOrganizationSchema,
  updateOrganizationSchema,
  updateSettingsSchema,
  addMemberSchema,
  updateMemberRoleSchema,
} from './organization.utils';
import {
  type Organization,
  type OrganizationWithMembers,
  type OrganizationMember,
  type OrganizationSettings,
  type OrganizationStats,
  type MemberRole,
  type CreateOrganizationInput,
  type UpdateOrganizationInput,
  type UpdateSettingsInput,
  type AddMemberInput,
  type AddMemberResult,
  type RemoveMemberResult,
  type TransferOwnershipResult,
  type DeleteOrganizationResult,
  type MemberFilters,
  type PaginatedMembers,
  type Invitation,
  ORGANIZATION_CONSTANTS,
  OrganizationError,
} from './organization.types';

const { REDIS_KEYS, ORG_CACHE_TTL, STATS_CACHE_TTL } = ORGANIZATION_CONSTANTS;

/**
 * Organization Module Class
 * Encapsulates all organization-related business logic
 */
class OrganizationModule {
  private readonly appUrl: string;

  constructor() {
    this.appUrl = config.appUrl || 'http://localhost:3000';
  }

  // ==========================================================================
  // ORGANIZATION CRUD
  // ==========================================================================

  /**
   * Create a new organization
   */
  async createOrganization(
    userId: string,
    input: CreateOrganizationInput
  ): Promise<Organization> {
    logger.info({
      type: 'org_create_started',
      userId,
      orgName: input.name,
    });

    try {
      // 1. Validate input
      const validated = createOrganizationSchema.parse(input);

      // 2. Check user's organization limit
      const existingOrgCount = await (prisma as any).organizationMember.count({
        where: { userId, role: 'OWNER' },
      });

      if (existingOrgCount >= ORGANIZATION_CONSTANTS.MAX_ORGANIZATIONS_PER_USER) {
        throw new OrganizationError(
          'You have reached the maximum number of organizations you can create',
          'ORGANIZATION_LIMIT_REACHED',
          403
        );
      }

      // 3. Create organization with owner as first member
      const organization = await prisma.$transaction(async (tx) => {
        // Create the organization
        const org = await (tx as any).organization.create({
          data: {
            name: validated.name,
            type: validated.type,
            description: validated.description,
            website: validated.website,
            address: validated.address,
            phone: validated.phone,
            email: validated.email,
            registrationNumber: validated.registrationNumber,
            ownerId: userId,
            status: 'ACTIVE',
            settings: {
              ...defaultSettings,
              compliance: {
                ...defaultSettings.compliance,
                regulatoryAreas: validated.regulatoryAreas || [],
              },
            },
          },
        });

        // Add creator as owner member
        await (tx as any).organizationMember.create({
          data: {
            userId,
            organizationId: org.id,
            role: 'OWNER',
            joinedAt: new Date(),
          },
        });

        // Update user's organizationId
        await tx.user.update({
          where: { id: userId },
          data: { organizationId: org.id },
        });

        return org;
      });

      logger.info({
        type: 'org_create_success',
        userId,
        orgId: organization.id,
      });

      return toOrganization(organization);
    } catch (error: any) {
      logger.error({
        type: 'org_create_error',
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get organization by ID
   */
  async getOrganization(orgId: string): Promise<Organization> {
    logger.info({
      type: 'org_get_started',
      orgId,
    });

    try {
      // 1. Check cache
      const cacheKey = `${REDIS_KEYS.ORGANIZATION}${orgId}`;
      const cached = await redis.get(cacheKey);
      
      if (cached) {
        logger.debug({ type: 'org_cache_hit', orgId });
        return JSON.parse(cached);
      }

      // 2. Get from database
      const org = await prisma.organization.findUnique({
        where: { id: orgId },
      });

      if (!org) {
        throw new OrganizationError(
          'Organization not found',
          'ORGANIZATION_NOT_FOUND',
          404
        );
      }

      // 3. Transform and cache
      const organization = toOrganization(org as any);
      
      await redis.setex(
        cacheKey,
        ORG_CACHE_TTL,
        JSON.stringify(organization)
      );

      logger.info({
        type: 'org_get_success',
        orgId,
      });

      return organization;
    } catch (error: any) {
      logger.error({
        type: 'org_get_error',
        orgId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get organization with members
   */
  async getOrganizationWithMembers(
    orgId: string
  ): Promise<OrganizationWithMembers> {
    const org = await this.getOrganization(orgId);
    const members = await this.getMembers(orgId);
    
    return {
      ...org,
      members: members.members,
      memberCount: members.total,
    };
  }

  /**
   * Update organization
   */
  async updateOrganization(
    userId: string,
    orgId: string,
    updates: UpdateOrganizationInput
  ): Promise<Organization> {
    logger.info({
      type: 'org_update_started',
      userId,
      orgId,
      updates: Object.keys(updates),
    });

    try {
      // 1. Validate input
      const validated = updateOrganizationSchema.parse(updates);

      // 2. Check permissions
      await this.checkPermission(userId, orgId, 'ADMIN');

      // 3. Update organization
      const org = await (prisma as any).organization.update({
        where: { id: orgId },
        data: {
          ...validated,
          updatedAt: new Date(),
        },
      });

      // 4. Invalidate cache
      await this.invalidateOrgCache(orgId);

      logger.info({
        type: 'org_update_success',
        userId,
        orgId,
      });

      return toOrganization(org as any);
    } catch (error: any) {
      logger.error({
        type: 'org_update_error',
        userId,
        orgId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Update organization settings
   */
  async updateSettings(
    userId: string,
    orgId: string,
    updates: UpdateSettingsInput
  ): Promise<OrganizationSettings> {
    logger.info({
      type: 'org_settings_update_started',
      userId,
      orgId,
    });

    try {
      // 1. Validate input
      const validated = updateSettingsSchema.parse(updates);

      // 2. Check permissions
      await this.checkPermission(userId, orgId, 'ADMIN');

      // 3. Get current settings
      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { settings: true } as any,
      });

      if (!org) {
        throw new OrganizationError(
          'Organization not found',
          'ORGANIZATION_NOT_FOUND',
          404
        );
      }

      // 4. Merge settings
      const currentSettings = parseSettings(org.settings);
      const newSettings = mergeSettings(currentSettings, validated as any);

      // 5. Update
      await (prisma as any).organization.update({
        where: { id: orgId },
        data: {
          settings: newSettings as any,
          updatedAt: new Date(),
        },
      });

      // 6. Invalidate cache
      await this.invalidateOrgCache(orgId);

      logger.info({
        type: 'org_settings_update_success',
        userId,
        orgId,
      });

      return newSettings;
    } catch (error: any) {
      logger.error({
        type: 'org_settings_update_error',
        userId,
        orgId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Delete organization (soft delete)
   */
  async deleteOrganization(
    userId: string,
    orgId: string
  ): Promise<DeleteOrganizationResult> {
    logger.info({
      type: 'org_delete_started',
      userId,
      orgId,
    });

    try {
      // 1. Check user is owner
      await this.checkPermission(userId, orgId, 'OWNER');

      // 2. Perform soft delete in transaction
      const result = await prisma.$transaction(async (tx) => {
        // Archive policies
        const archivedPolicies = await (tx as any).policy.updateMany({ where: { organizationId: orgId },
          data: { status: 'ARCHIVED' as any },
        });

        // Archive documents
        const archivedDocuments = await tx.legalDocument.updateMany({
          where: { organizationId: orgId },
          data: { status: 'ARCHIVED' as any },
        });

        // Get members for notifications
        const members = await (tx as any).organizationMember.findMany({
          where: { organizationId: orgId },
          include: { user: { select: { id: true, email: true, fullName: true } } },
        });

        // Remove all members (except owner who's deleting)
        await (tx as any).organizationMember.deleteMany({
          where: { organizationId: orgId },
        });

        // Update users to remove organizationId
        await tx.user.updateMany({
          where: { organizationId: orgId },
          data: { organizationId: null },
        });

        // Soft delete organization
        await (tx as any).organization.update({
          where: { id: orgId },
          data: {
            status: 'DELETED',
            deletedAt: new Date(),
            updatedAt: new Date(),
          },
        });

        return {
          archivedPolicies: archivedPolicies.count,
          archivedDocuments: archivedDocuments.count,
          removedMembers: members.length,
          members,
        };
      });

      // 3. Invalidate all caches
      await this.invalidateOrgCache(orgId);

      // 4. Send notifications to members (async, don't wait)
      // Note: In production, this should be queued
      
      logger.info({
        type: 'org_delete_success',
        userId,
        orgId,
        archivedPolicies: result.archivedPolicies,
        archivedDocuments: result.archivedDocuments,
        removedMembers: result.removedMembers,
      });

      return {
        success: true,
        archivedPolicies: result.archivedPolicies,
        archivedDocuments: result.archivedDocuments,
        removedMembers: result.removedMembers,
        message: 'Organization deleted successfully',
      };
    } catch (error: any) {
      logger.error({
        type: 'org_delete_error',
        userId,
        orgId,
        error: error.message,
      });
      throw error;
    }
  }

  // ==========================================================================
  // MEMBER MANAGEMENT
  // ==========================================================================

  /**
   * Get organization members
   */
  async getMembers(
    orgId: string,
    filters?: MemberFilters
  ): Promise<PaginatedMembers> {
    logger.info({
      type: 'org_get_members_started',
      orgId,
    });

    try {
      const { role, search, page = 1, limit = 20 } = filters || {};
      const skip = (page - 1) * limit;

      // Build where clause
      const where: any = { organizationId: orgId };
      
      if (role) {
        where.role = role;
      }
      
      if (search) {
        where.user = {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
          ],
        };
      }

      // Get members with pagination
      const [members, total] = await Promise.all([
        (prisma as any).organizationMember.findMany({
          where,
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                avatarUrl: true,
                lastLoginAt: true,
              },
            },
          },
          orderBy: [
            { role: 'asc' },
            { joinedAt: 'asc' },
          ],
          skip,
          take: limit,
        }),
        (prisma as any).organizationMember.count({ where }),
      ]);

      logger.info({
        type: 'org_get_members_success',
        orgId,
        count: members.length,
        total,
      });

      return {
        members: members.map(toOrganizationMember),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      };
    } catch (error: any) {
      logger.error({
        type: 'org_get_members_error',
        orgId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Add member to organization
   */
  async addMember(
    requesterId: string,
    orgId: string,
    input: AddMemberInput
  ): Promise<AddMemberResult> {
    logger.info({
      type: 'org_add_member_started',
      requesterId,
      orgId,
      memberEmail: input.email,
    });

    try {
      // 1. Validate input
      const validated = addMemberSchema.parse(input);

      // 2. Check permissions
      await this.checkPermission(requesterId, orgId, 'ADMIN');

      // 3. Get organization
      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { name: true, settings: true } as any,
      });

      if (!org) {
        throw new OrganizationError(
          'Organization not found',
          'ORGANIZATION_NOT_FOUND',
          404
        );
      }

      // 4. Find user by email
      const user = await prisma.user.findUnique({
        where: { email: validated.email.toLowerCase() },
      });

      // 5. Check member limit
      const memberCount = await (prisma as any).organizationMember.count({
        where: { organizationId: orgId },
      });

      if (memberCount >= ORGANIZATION_CONSTANTS.MAX_MEMBERS_PRO) {
        throw new OrganizationError(
          'Organization has reached member limit',
          'MEMBER_LIMIT_REACHED',
          403
        );
      }

      // 6. Get requester info for invitation email
      const requester = await prisma.user.findUnique({
        where: { id: requesterId },
        select: { fullName: true },
      });

      if (user) {
        // User exists - check if already a member
        const existingMember = await (prisma as any).organizationMember.findUnique({
          where: {
            userId_organizationId: {
              userId: user.id,
              organizationId: orgId,
            },
          },
        });

        if (existingMember) {
          throw new OrganizationError(
            'User is already a member of this organization',
            'ALREADY_MEMBER',
            409
          );
        }

        // Add as member directly
        const member = await (prisma as any).organizationMember.create({
          data: {
            userId: user.id,
            organizationId: orgId,
            role: validated.role,
            invitedBy: requesterId,
            joinedAt: new Date(),
          },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                avatarUrl: true,
                lastLoginAt: true,
              },
            },
          },
        });

        // Update user's organizationId if they don't have one
        if (!user.organizationId) {
          await prisma.user.update({
            where: { id: user.id },
            data: { organizationId: orgId },
          });
        }

        // Invalidate cache
        await this.invalidateMembersCache(orgId);

        logger.info({
          type: 'org_add_member_success',
          requesterId,
          orgId,
          memberId: user.id,
        });

        return {
          success: true,
          member: toOrganizationMember(member),
          message: `${user.fullName} has been added to the organization`,
        };
      } else {
        // User doesn't exist - create invitation
        const token = generateInvitationToken();
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + ORGANIZATION_CONSTANTS.INVITATION_EXPIRY_DAYS);

        // Store invitation in Redis
        const invitationData: Invitation = {
          id: token,
          organizationId: orgId,
          email: validated.email.toLowerCase(),
          role: validated.role,
          invitedBy: requesterId,
          token,
          expiresAt,
          acceptedAt: null,
          createdAt: new Date(),
        };

        await redis.setex(
          `${REDIS_KEYS.INVITATION}${token}`,
          ORGANIZATION_CONSTANTS.INVITATION_EXPIRY_DAYS * 24 * 60 * 60,
          JSON.stringify(invitationData)
        );

        // Send invitation email
        if (validated.sendInvite) {
          const inviteUrl = `${this.appUrl}/invitation?token=${token}`;
          const emailContent = generateInvitationEmail(
            (org as any).name,
            (requester as any)?.fullName || 'A team member',
            validated.role,
            inviteUrl
          );

          await sendEmail({
            to: validated.email,
            subject: emailContent.subject,
            text: emailContent.text,
            html: emailContent.html,
          });
        }

        logger.info({
          type: 'org_invitation_sent',
          requesterId,
          orgId,
          invitationEmail: validated.email,
        });

        return {
          success: true,
          invitation: invitationData,
          message: `Invitation sent to ${validated.email}`,
        };
      }
    } catch (error: any) {
      logger.error({
        type: 'org_add_member_error',
        requesterId,
        orgId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Accept invitation
   */
  async acceptInvitation(
    userId: string,
    token: string
  ): Promise<OrganizationMember> {
    logger.info({
      type: 'org_accept_invitation_started',
      userId,
      token: token.slice(0, 8) + '...',
    });

    try {
      // 1. Get invitation from Redis
      const invitationData = await redis.get(`${REDIS_KEYS.INVITATION}${token}`);
      
      if (!invitationData) {
        throw new OrganizationError(
          'Invitation not found or expired',
          'INVITATION_NOT_FOUND',
          404
        );
      }

      const invitation: Invitation = JSON.parse(invitationData);

      // 2. Check if expired
      if (new Date(invitation.expiresAt) < new Date()) {
        await redis.del(`${REDIS_KEYS.INVITATION}${token}`);
        throw new OrganizationError(
          'Invitation has expired',
          'INVITATION_EXPIRED',
          400
        );
      }

      // 3. Get user and verify email matches
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, organizationId: true },
      });

      if (!user) {
        throw new OrganizationError(
          'User not found',
          'USER_NOT_FOUND',
          404
        );
      }

      if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
        throw new OrganizationError(
          'This invitation was sent to a different email address',
          'INVITATION_NOT_FOUND',
          403
        );
      }

      // 4. Check not already a member
      const existingMember = await (prisma as any).organizationMember.findUnique({
        where: {
          userId_organizationId: {
            userId,
            organizationId: invitation.organizationId,
          },
        },
      });

      if (existingMember) {
        await redis.del(`${REDIS_KEYS.INVITATION}${token}`);
        throw new OrganizationError(
          'You are already a member of this organization',
          'ALREADY_MEMBER',
          409
        );
      }

      // 5. Add member
      const member = await (prisma as any).organizationMember.create({
        data: {
          userId,
          organizationId: invitation.organizationId,
          role: invitation.role,
          invitedBy: invitation.invitedBy,
          joinedAt: new Date(),
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              avatarUrl: true,
              lastLoginAt: true,
            },
          },
        },
      });

      // 6. Update user's organizationId if not set
      if (!user.organizationId) {
        await prisma.user.update({
          where: { id: userId },
          data: { organizationId: invitation.organizationId },
        });
      }

      // 7. Delete invitation
      await redis.del(`${REDIS_KEYS.INVITATION}${token}`);

      // 8. Invalidate cache
      await this.invalidateMembersCache(invitation.organizationId);

      logger.info({
        type: 'org_accept_invitation_success',
        userId,
        orgId: invitation.organizationId,
      });

      return toOrganizationMember(member);
    } catch (error: any) {
      logger.error({
        type: 'org_accept_invitation_error',
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Remove member from organization
   */
  async removeMember(
    requesterId: string,
    orgId: string,
    memberUserId: string
  ): Promise<RemoveMemberResult> {
    logger.info({
      type: 'org_remove_member_started',
      requesterId,
      orgId,
      memberUserId,
    });

    try {
      // 1. Check permissions
      await this.checkPermission(requesterId, orgId, 'ADMIN');

      // 2. Get the member to remove
      const member = await (prisma as any).organizationMember.findUnique({
        where: {
          userId_organizationId: {
            userId: memberUserId,
            organizationId: orgId,
          },
        },
        include: {
          user: { select: { name: true, email: true } },
        },
      });

      if (!member) {
        throw new OrganizationError(
          'Member not found',
          'MEMBER_NOT_FOUND',
          404
        );
      }

      // 3. Cannot remove owner
      if (member.role === 'OWNER') {
        throw new OrganizationError(
          'Cannot remove the owner. Transfer ownership first.',
          'CANNOT_REMOVE_OWNER',
          403
        );
      }

      // 4. Check if trying to remove last admin (excluding owner)
      if (member.role === 'ADMIN') {
        const adminCount = await (prisma as any).organizationMember.count({
          where: {
            organizationId: orgId,
            role: { in: ['ADMIN', 'OWNER'] },
          },
        });

        if (adminCount <= 2) { // Owner + this admin
          throw new OrganizationError(
            'Cannot remove the last administrator',
            'CANNOT_REMOVE_LAST_ADMIN',
            403
          );
        }
      }

      // 5. Get organization for email
      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { name: true },
      });

      // 6. Remove member
      await (prisma as any).organizationMember.delete({
        where: {
          userId_organizationId: {
            userId: memberUserId,
            organizationId: orgId,
          },
        },
      });

      // 7. Update user's organizationId if this was their org
      const user = await prisma.user.findUnique({
        where: { id: memberUserId },
        select: { organizationId: true },
      });

      if (user?.organizationId === orgId) {
        await prisma.user.update({
          where: { id: memberUserId },
          data: { organizationId: null },
        });
      }

      // 8. Invalidate cache
      await this.invalidateMembersCache(orgId);

      // 9. Send notification email
      if (org) {
        const emailContent = generateMemberRemovedEmail(
          member.user.fullName,
          org.name
        );

        await sendEmail({
          to: member.user.email,
          subject: emailContent.subject,
          text: emailContent.text,
          html: emailContent.html,
        });
      }

      logger.info({
        type: 'org_remove_member_success',
        requesterId,
        orgId,
        memberUserId,
      });

      return {
        success: true,
        message: `${member.user.fullName} has been removed from the organization`,
      };
    } catch (error: any) {
      logger.error({
        type: 'org_remove_member_error',
        requesterId,
        orgId,
        memberUserId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Update member role
   */
  async updateMemberRole(
    requesterId: string,
    orgId: string,
    memberUserId: string,
    newRole: MemberRole
  ): Promise<OrganizationMember> {
    logger.info({
      type: 'org_update_role_started',
      requesterId,
      orgId,
      memberUserId,
      newRole,
    });

    try {
      // 1. Validate role
      updateMemberRoleSchema.parse({ role: newRole });

      // 2. Get requester's role
      const requesterMember = await (prisma as any).organizationMember.findUnique({
        where: {
          userId_organizationId: {
            userId: requesterId,
            organizationId: orgId,
          },
        },
      });

      if (!requesterMember) {
        throw new OrganizationError(
          'You are not a member of this organization',
          'NOT_MEMBER',
          403
        );
      }

      // 3. Get target member
      const targetMember = await (prisma as any).organizationMember.findUnique({
        where: {
          userId_organizationId: {
            userId: memberUserId,
            organizationId: orgId,
          },
        },
        include: {
          user: { select: { name: true, email: true } },
        },
      });

      if (!targetMember) {
        throw new OrganizationError(
          'Member not found',
          'MEMBER_NOT_FOUND',
          404
        );
      }

      // 4. Check permissions
      if (!canModifyRole(
        requesterMember.role as MemberRole,
        targetMember.role as MemberRole,
        newRole
      )) {
        throw new OrganizationError(
          'You do not have permission to change this role',
          'INSUFFICIENT_PERMISSIONS',
          403
        );
      }

      // 5. Update role
      const updatedMember = await (prisma as any).organizationMember.update({
        where: {
          userId_organizationId: {
            userId: memberUserId,
            organizationId: orgId,
          },
        },
        data: { role: newRole },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              avatarUrl: true,
              lastLoginAt: true,
            },
          },
        },
      });

      // 6. Invalidate cache
      await this.invalidateMembersCache(orgId);

      // 7. Send notification email
      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { name: true },
      });

      if (org) {
        const emailContent = generateRoleChangeEmail(
          targetMember.user.fullName,
          org.name,
          targetMember.role as MemberRole,
          newRole
        );

        await sendEmail({
          to: targetMember.user.email,
          subject: emailContent.subject,
          text: emailContent.text,
          html: emailContent.html,
        });
      }

      logger.info({
        type: 'org_update_role_success',
        requesterId,
        orgId,
        memberUserId,
        oldRole: targetMember.role,
        newRole,
      });

      return toOrganizationMember(updatedMember);
    } catch (error: any) {
      logger.error({
        type: 'org_update_role_error',
        requesterId,
        orgId,
        memberUserId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Transfer organization ownership
   */
  async transferOwnership(
    currentOwnerId: string,
    orgId: string,
    newOwnerId: string
  ): Promise<TransferOwnershipResult> {
    logger.info({
      type: 'org_transfer_ownership_started',
      currentOwnerId,
      orgId,
      newOwnerId,
    });

    try {
      // 1. Verify current owner
      await this.checkPermission(currentOwnerId, orgId, 'OWNER');

      // 2. Verify new owner is a member
      const newOwnerMember = await (prisma as any).organizationMember.findUnique({
        where: {
          userId_organizationId: {
            userId: newOwnerId,
            organizationId: orgId,
          },
        },
        include: {
          user: { select: { name: true, email: true } },
        },
      });

      if (!newOwnerMember) {
        throw new OrganizationError(
          'New owner must be a member of the organization',
          'NOT_MEMBER',
          400
        );
      }

      // 3. Get current owner info
      const currentOwner = await prisma.user.findUnique({
        where: { id: currentOwnerId },
        select: { fullName: true, email: true },
      });

      // 4. Get organization
      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { name: true },
      });

      // 5. Perform transfer in transaction
      await prisma.$transaction(async (tx) => {
        // Update new owner to OWNER role
        await (tx as any).organizationMember.update({
          where: {
            userId_organizationId: {
              userId: newOwnerId,
              organizationId: orgId,
            },
          },
          data: { role: 'OWNER' },
        });

        // Demote current owner to ADMIN
        await (tx as any).organizationMember.update({
          where: {
            userId_organizationId: {
              userId: currentOwnerId,
              organizationId: orgId,
            },
          },
          data: { role: 'ADMIN' },
        });

        // Update organization's ownerId
        await (tx as any).organization.update({
          where: { id: orgId },
          data: {
            ownerId: newOwnerId,
            updatedAt: new Date(),
          },
        });
      });

      // 6. Invalidate caches
      await this.invalidateOrgCache(orgId);
      await this.invalidateMembersCache(orgId);

      // 7. Send emails to both parties
      if (org && currentOwner) {
        // Email to new owner
        const newOwnerEmail = generateOwnershipTransferEmail(
          newOwnerMember.user.fullName,
          (currentOwner as any).fullName,
          org.name,
          true
        );

        await sendEmail({
          to: newOwnerMember.user.email,
          subject: newOwnerEmail.subject,
          text: newOwnerEmail.text,
          html: newOwnerEmail.html,
        });

        // Email to previous owner
        const prevOwnerEmail = generateOwnershipTransferEmail(
          newOwnerMember.user.fullName,
          (currentOwner as any).fullName,
          org.name,
          false
        );

        await sendEmail({
          to: currentOwner.email!,
          subject: prevOwnerEmail.subject,
          text: prevOwnerEmail.text,
          html: prevOwnerEmail.html,
        });
      }

      logger.info({
        type: 'org_transfer_ownership_success',
        currentOwnerId,
        orgId,
        newOwnerId,
      });

      return {
        success: true,
        previousOwner: { id: currentOwnerId, newRole: 'ADMIN' },
        newOwner: { id: newOwnerId, role: 'OWNER' },
        message: 'Ownership transferred successfully',
      };
    } catch (error: any) {
      logger.error({
        type: 'org_transfer_ownership_error',
        currentOwnerId,
        orgId,
        newOwnerId,
        error: error.message,
      });
      throw error;
    }
  }

  // ==========================================================================
  // STATISTICS
  // ==========================================================================

  /**
   * Get organization statistics
   */
  async getStats(orgId: string): Promise<OrganizationStats> {
    logger.info({
      type: 'org_get_stats_started',
      orgId,
    });

    try {
      // Check cache
      const cacheKey = `${REDIS_KEYS.STATS}${orgId}`;
      const cached = await redis.get(cacheKey);
      
      if (cached) {
        return JSON.parse(cached);
      }

      // Get organization
      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { createdAt: true },
      });

      if (!org) {
        throw new OrganizationError(
          'Organization not found',
          'ORGANIZATION_NOT_FOUND',
          404
        );
      }

      // Get all stats in parallel
      const [
        members,
        membersByRole,
        policies,
        documents,
        queries,
        storageUsage,
        aiUsage,
        lastActivity,
      ] = await Promise.all([
        // Member stats
        (prisma as any).organizationMember.count({
          where: { organizationId: orgId },
        }),
        (prisma as any).organizationMember.groupBy({
          by: ['role'],
          where: { organizationId: orgId },
          _count: true,
        }),
        // Policy stats
        (prisma as any).policy.groupBy({
          by: ['status'],
          where: { organizationId: orgId },
          _count: true,
        }),
        // Document stats
        prisma.legalDocument.count({
          where: { organizationId: orgId },
        }),
        // Query stats
        prisma.complianceQuery.count({
          where: {
            user: { organizationId: orgId },
          },
        }),
        // Storage usage
        prisma.legalDocument.aggregate({
          where: { organizationId: orgId },
          _sum: { fileSize: true } as any,
        }),
        // AI usage this month
        (prisma as any).aiUsage.aggregate({
          where: {
            user: { organizationId: orgId },
            createdAt: {
              gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
            },
          },
          _sum: { tokens: true },
        }),
        // Last activity
        (prisma as any).activityLog.findFirst({
          where: {
            user: { organizationId: orgId },
          },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
      ]);

      // Process policy stats
      const policyStats = policies.reduce(
        (acc: Record<string, number>, p: any) => {
          acc[String(p.status)] = (p._count && typeof p._count === 'object') ? (p._count as any)._all ?? 0 : Number(p._count) || 0;
          return acc;
        },
        {} as Record<string, number>
      );

      // Process member roles
      const roleStats = membersByRole.reduce(
        (acc: any, m: any) => {
          acc[m.role as MemberRole] = (m._count && typeof m._count === 'object') ? (m._count as any)._all ?? 0 : Number(m._count) || 0;
          return acc;
        },
        { OWNER: 0, ADMIN: 0, MEMBER: 0, VIEWER: 0 } as Record<MemberRole, number>
      );

      const stats: OrganizationStats = {
        totalMembers: members,
        activeMembers: members, // TODO: Track active status
        membersByRole: roleStats,
        totalPolicies: (Object.values(policyStats) as number[]).reduce((a: number, b: number) => a + b, 0),
        publishedPolicies: policyStats['PUBLISHED'] || policyStats['COMPLETED'] || 0,
        draftPolicies: policyStats['DRAFT'] || 0,
        totalDocuments: documents,
        totalQueries: queries,
        storageUsedBytes: (storageUsage._sum as any)?.fileSize || 0,
        storageQuotaBytes: 10 * 1024 * 1024 * 1024, // 10GB default
        aiTokensUsedThisMonth: aiUsage._sum.tokens || 0,
        aiTokensQuota: 1000000, // 1M tokens default
        complianceScore: null, // TODO: Calculate from compliance module
        pendingRequirements: 0,
        completedRequirements: 0,
        upcomingDeadlines: 0,
        lastActivityAt: lastActivity?.createdAt || null,
        createdAt: org.createdAt,
      };

      // Cache stats
      await redis.setex(cacheKey, STATS_CACHE_TTL, JSON.stringify(stats));

      logger.info({
        type: 'org_get_stats_success',
        orgId,
      });

      return stats;
    } catch (error: any) {
      logger.error({
        type: 'org_get_stats_error',
        orgId,
        error: error.message,
      });
      throw error;
    }
  }

  // ==========================================================================
  // HELPER METHODS
  // ==========================================================================

  /**
   * Check if user has required permission in organization
   */
  async checkPermission(
    userId: string,
    orgId: string,
    requiredRole: MemberRole
  ): Promise<void> {
    const member = await (prisma as any).organizationMember.findUnique({
      where: {
        userId_organizationId: {
          userId,
          organizationId: orgId,
        },
      },
    });

    if (!member) {
      throw new OrganizationError(
        'You are not a member of this organization',
        'NOT_MEMBER',
        403
      );
    }

    if (!hasPermission(member.role as MemberRole, requiredRole)) {
      throw new OrganizationError(
        'You do not have permission to perform this action',
        'INSUFFICIENT_PERMISSIONS',
        403
      );
    }
  }

  /**
   * Get user's role in organization
   */
  async getMemberRole(
    userId: string,
    orgId: string
  ): Promise<MemberRole | null> {
    const member = await (prisma as any).organizationMember.findUnique({
      where: {
        userId_organizationId: {
          userId,
          organizationId: orgId,
        },
      },
      select: { role: true },
    });

    return member ? (member.role as MemberRole) : null;
  }

  /**
   * Invalidate organization cache
   */
  private async invalidateOrgCache(orgId: string): Promise<void> {
    await redis.del(`${REDIS_KEYS.ORGANIZATION}${orgId}`);
    await redis.del(`${REDIS_KEYS.STATS}${orgId}`);
  }

  /**
   * Invalidate members cache
   */
  private async invalidateMembersCache(orgId: string): Promise<void> {
    await redis.del(`${REDIS_KEYS.MEMBERS}${orgId}`);
    await redis.del(`${REDIS_KEYS.STATS}${orgId}`);
  }
}

// Export singleton instance
export const organizationModule = new OrganizationModule();

// Export class for testing
export { OrganizationModule };
