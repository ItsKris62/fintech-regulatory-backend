/**
 * Compliance Tracker
 * Handles requirement tracking, deadline management, and compliance certificates
 */

import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { mailer as _mailer } from '@/lib/email/mailer.service';
import { sendEmail } from '@/lib/email/client';
import { storageService } from '@/lib/storage/storage.service';
import { logger } from '@/utils/logger';
import {
  type Requirement,
  type RequirementStatus,
  type UpcomingDeadline,
  type Evidence,
  type EvidenceType,
  type RegulatoryArea,
  type GapPriority,
  COMPLIANCE_CONSTANTS,
  REGULATORY_AREA_NAMES,
} from './compliance.types';
import {
  toRequirement,
  toUpcomingDeadline,
  generateDeadlineReminderEmail,
} from './compliance.utils';
import { complianceScorer } from './compliance-scorer';

const { REDIS_KEYS, REMINDER_DAYS, CERTIFICATE_VALIDITY_DAYS } = COMPLIANCE_CONSTANTS;

/**
 * Compliance Tracker Class
 * Handles all tracking and deadline management
 */
class ComplianceTracker {
  /**
   * Create a new requirement
   */
  async createRequirement(
    orgId: string,
    params: {
      area: RegulatoryArea;
      title: string;
      description: string;
      priority?: GapPriority;
      dueDate?: Date;
      assignedTo?: string;
      notes?: string;
    }
  ): Promise<Requirement> {
    logger.info({
      type: 'compliance_create_requirement_started',
      orgId,
      area: params.area,
    });

    try {
      const requirement = await (prisma as any).requirement.create({
        data: {
          organizationId: orgId,
          regulatoryArea: params.area,
          title: params.title,
          description: params.description,
          status: 'NOT_STARTED',
          priority: params.priority || 'MEDIUM',
          dueDate: params.dueDate,
          assignedTo: params.assignedTo,
          notes: params.notes,
          evidence: [],
        },
      });

      // Set up deadline reminder if due date specified
      if (params.dueDate) {
        await this.scheduleDeadlineReminder(requirement.id, params.dueDate);
      }

      // Invalidate cache
      await this.invalidateRequirementsCache(orgId);
      await complianceScorer.invalidateScore(orgId);

      logger.info({
        type: 'compliance_create_requirement_success',
        orgId,
        requirementId: requirement.id,
      });

      return toRequirement(requirement);
    } catch (error: any) {
      logger.error({
        type: 'compliance_create_requirement_error',
        orgId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Update requirement status
   */
  async updateRequirementStatus(
    requirementId: string,
    status: RequirementStatus,
    notes?: string
  ): Promise<Requirement> {
    logger.info({
      type: 'compliance_update_status_started',
      requirementId,
      status,
    });

    try {
      const updateData: any = {
        status,
        updatedAt: new Date(),
      };

      if (notes) {
        updateData.notes = notes;
      }

      if (status === 'COMPLETED') {
        updateData.completedAt = new Date();
      }

      const requirement = await (prisma as any).requirement.update({
        where: { id: requirementId },
        data: updateData,
      });

      // Invalidate caches
      await this.invalidateRequirementsCache(requirement.organizationId);
      await complianceScorer.invalidateScore(requirement.organizationId);

      logger.info({
        type: 'compliance_update_status_success',
        requirementId,
        status,
      });

      return toRequirement(requirement);
    } catch (error: any) {
      logger.error({
        type: 'compliance_update_status_error',
        requirementId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Track completion with evidence
   */
  async trackCompletion(
    requirementId: string,
    evidence: {
      type: EvidenceType;
      title: string;
      description?: string;
      documentId?: string;
      url?: string;
    },
    userId: string
  ): Promise<Requirement> {
    logger.info({
      type: 'compliance_track_completion_started',
      requirementId,
      evidenceType: evidence.type,
    });

    try {
      // Get current requirement
      const current = await (prisma as any).requirement.findUnique({
        where: { id: requirementId },
      });

      if (!current) {
        throw new Error('Requirement not found');
      }

      // Add evidence
      const newEvidence: Evidence = {
        id: crypto.randomUUID(),
        type: evidence.type,
        title: evidence.title,
        description: evidence.description || '',
        documentId: evidence.documentId,
        url: evidence.url,
        uploadedBy: userId,
        uploadedAt: new Date(),
      };

      const existingEvidence = current.evidence as Evidence[] || [];
      const updatedEvidence = [...existingEvidence, newEvidence];

      // Update requirement
      const requirement = await (prisma as any).requirement.update({
        where: { id: requirementId },
        data: {
          evidence: updatedEvidence,
          status: 'UNDER_REVIEW',
          updatedAt: new Date(),
        },
      });

      // Invalidate caches
      await this.invalidateRequirementsCache(requirement.organizationId);
      await complianceScorer.invalidateScore(requirement.organizationId);

      logger.info({
        type: 'compliance_track_completion_success',
        requirementId,
        evidenceId: newEvidence.id,
      });

      return toRequirement(requirement);
    } catch (error: any) {
      logger.error({
        type: 'compliance_track_completion_error',
        requirementId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get requirements for an organization
   */
  async getRequirements(
    orgId: string,
    filters?: {
      area?: RegulatoryArea;
      status?: RequirementStatus;
      priority?: GapPriority;
      assignedTo?: string;
      overdue?: boolean;
      page?: number;
      limit?: number;
    }
  ): Promise<{
    requirements: Requirement[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = filters?.page || 1;
    const limit = filters?.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = { organizationId: orgId };

    if (filters?.area) where.regulatoryArea = filters.area;
    if (filters?.status) where.status = filters.status;
    if (filters?.priority) where.priority = filters.priority;
    if (filters?.assignedTo) where.assignedTo = filters.assignedTo;
    if (filters?.overdue) {
      where.dueDate = { lt: new Date() };
      where.status = { notIn: ['COMPLETED', 'NOT_APPLICABLE'] };
    }

    const [requirements, total] = await Promise.all([
      (prisma as any).requirement.findMany({
        where,
        skip,
        take: limit,
        orderBy: [
          { priority: 'asc' },
          { dueDate: 'asc' },
        ],
      }),
      (prisma as any).requirement.count({ where }),
    ]);

    return {
      requirements: requirements.map(toRequirement),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get completion percentage
   */
  async getCompletionPercentage(orgId: string): Promise<number> {
    const requirements = await (prisma as any).requirement.findMany({
      where: { organizationId: orgId },
      select: { status: true },
    });

    if (requirements.length === 0) return 100;

    const completed = requirements.filter(
      (r: any) => r.status === 'COMPLETED' || r.status === 'NOT_APPLICABLE'
    ).length;

    return Math.round((completed / requirements.length) * 100);
  }

  /**
   * Get upcoming deadlines
   */
  async getUpcomingDeadlines(
    orgId: string,
    daysAhead: number = 30
  ): Promise<UpcomingDeadline[]> {
    logger.info({
      type: 'compliance_get_deadlines_started',
      orgId,
      daysAhead,
    });

    try {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + daysAhead);

      const requirements = await (prisma as any).requirement.findMany({
        where: {
          organizationId: orgId,
          dueDate: {
            gte: new Date(),
            lte: futureDate,
          },
          status: {
            notIn: ['COMPLETED', 'NOT_APPLICABLE'],
          },
        },
        orderBy: { dueDate: 'asc' },
      });

      const deadlines = requirements
        .map(toRequirement)
        .filter((r: any) => r.dueDate)
        .map(toUpcomingDeadline);

      logger.info({
        type: 'compliance_get_deadlines_success',
        orgId,
        count: deadlines.length,
      });

      return deadlines;
    } catch (error: any) {
      logger.error({
        type: 'compliance_get_deadlines_error',
        orgId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get overdue requirements
   */
  async getOverdueRequirements(orgId: string): Promise<Requirement[]> {
    const requirements = await (prisma as any).requirement.findMany({
      where: {
        organizationId: orgId,
        dueDate: { lt: new Date() },
        status: { notIn: ['COMPLETED', 'NOT_APPLICABLE'] },
      },
      orderBy: { dueDate: 'asc' },
    });

    // Update status to OVERDUE if not already
    for (const req of requirements) {
      if (req.status !== 'OVERDUE') {
        await (prisma as any).requirement.update({
          where: { id: req.id },
          data: { status: 'OVERDUE' },
        });
      }
    }

    return requirements.map(toRequirement);
  }

  /**
   * Send deadline reminders
   */
  async sendDeadlineReminders(): Promise<{
    sent: number;
    failed: number;
  }> {
    logger.info({ type: 'compliance_send_reminders_started' });

    const results = { sent: 0, failed: 0 };

    try {
      // Get all requirements with upcoming deadlines
      for (const daysAhead of REMINDER_DAYS) {
        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() + daysAhead);
        
        // Find requirements due on target date
        const startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);

        const requirements = await (prisma as any).requirement.findMany({
          where: {
            dueDate: {
              gte: startOfDay,
              lte: endOfDay,
            },
            status: { notIn: ['COMPLETED', 'NOT_APPLICABLE'] },
          },
          include: {
            organization: {
              select: {
                members: {
                  where: { role: { in: ['OWNER', 'ADMIN'] } },
                  include: {
                    user: {
                      select: { name: true, email: true },
                    },
                  },
                },
              },
            },
          },
        });

        for (const req of requirements) {
          const deadline = toUpcomingDeadline(toRequirement(req));
          
          // Send to all admins/owners
          for (const member of req.organization.members) {
            try {
              const email = generateDeadlineReminderEmail(
                member.user.name,
                deadline
              );

              await sendEmail({
                to: member.user.email,
                subject: email.subject,
                text: email.text,
                html: email.html,
              });

              results.sent++;
            } catch (emailError) {
              logger.warn({
                type: 'compliance_reminder_email_failed',
                requirementId: req.id,
                email: member.user.email,
                error: (emailError as Error).message,
              });
              results.failed++;
            }
          }
        }
      }

      logger.info({
        type: 'compliance_send_reminders_success',
        ...results,
      });

      return results;
    } catch (error: any) {
      logger.error({
        type: 'compliance_send_reminders_error',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Generate compliance certificate
   */
  async generateCertificate(
    orgId: string,
    area: RegulatoryArea
  ): Promise<{
    certificateId: string;
    downloadUrl: string;
    validUntil: Date;
  }> {
    logger.info({
      type: 'compliance_generate_certificate_started',
      orgId,
      area,
    });

    try {
      // Check if area is compliant
      const score = await complianceScorer.scoreByArea(orgId, area);
      
      if (score < 90) {
        throw new Error(
          `Cannot generate certificate. Area score (${score}%) is below 90% threshold.`
        );
      }

      // Get organization details
      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { name: true },
      });

      if (!org) {
        throw new Error('Organization not found');
      }

      // Generate certificate content
      const certificateId = crypto.randomUUID();
      const validUntil = new Date();
      validUntil.setDate(validUntil.getDate() + CERTIFICATE_VALIDITY_DAYS);

      const certificateHtml = this.generateCertificateHtml({
        certificateId,
        organizationName: org.name,
        area,
        areaName: REGULATORY_AREA_NAMES[area],
        score,
        issuedAt: new Date(),
        validUntil,
      });

      // Convert to PDF (using simple HTML for now)
      // In production, use a proper PDF generator
      const buffer = Buffer.from(certificateHtml, 'utf-8');

      // Upload to storage
      const uploadResult = await storageService.uploadTempFile(
        buffer,
        `certificate-${certificateId}.html`,
        7 * 24 * 60 * 60
      );

      // Generate download URL
      const downloadUrl = await storageService.getDownloadUrl(
        uploadResult.key,
        7 * 24 * 60 * 60
      );

      // Save certificate record
      await (prisma as any).complianceCertificate.create({
        data: {
          id: certificateId,
          organizationId: orgId,
          regulatoryArea: area,
          score,
          validUntil,
          fileKey: uploadResult.key,
        },
      });

      logger.info({
        type: 'compliance_generate_certificate_success',
        orgId,
        area,
        certificateId,
      });

      return {
        certificateId,
        downloadUrl,
        validUntil,
      };
    } catch (error: any) {
      logger.error({
        type: 'compliance_generate_certificate_error',
        orgId,
        area,
        error: error.message,
      });
      throw error;
    }
  }

  // ==========================================================================
  // PRIVATE HELPER METHODS
  // ==========================================================================

  /**
   * Schedule deadline reminder
   */
  private async scheduleDeadlineReminder(
    requirementId: string,
    dueDate: Date
  ): Promise<void> {
    // Store reminder info in Redis
    const key = `${REDIS_KEYS.DEADLINES}${requirementId}`;
    await redis.setex(
      key,
      Math.max(0, Math.floor((dueDate.getTime() - Date.now()) / 1000)),
      JSON.stringify({
        requirementId,
        dueDate: dueDate.toISOString(),
        remindersSent: [],
      })
    );
  }

  /**
   * Invalidate requirements cache
   */
  private async invalidateRequirementsCache(orgId: string): Promise<void> {
    await redis.del(`${REDIS_KEYS.REQUIREMENTS}${orgId}`);
  }

  /**
   * Generate certificate HTML
   */
  private generateCertificateHtml(data: {
    certificateId: string;
    organizationName: string;
    area: RegulatoryArea;
    areaName: string;
    score: number;
    issuedAt: Date;
    validUntil: Date;
  }): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Compliance Certificate</title>
  <style>
    body {
      font-family: 'Georgia', serif;
      margin: 0;
      padding: 40px;
      background: #f8f4e9;
    }
    .certificate {
      max-width: 800px;
      margin: 0 auto;
      background: white;
      border: 3px solid #1e40af;
      padding: 60px;
      text-align: center;
      position: relative;
    }
    .certificate::before {
      content: '';
      position: absolute;
      top: 10px;
      left: 10px;
      right: 10px;
      bottom: 10px;
      border: 1px solid #1e40af;
    }
    .logo {
      font-size: 32px;
      color: #1e40af;
      margin-bottom: 20px;
    }
    .title {
      font-size: 48px;
      color: #1e40af;
      margin-bottom: 10px;
      font-weight: bold;
    }
    .subtitle {
      font-size: 18px;
      color: #64748b;
      margin-bottom: 40px;
    }
    .org-name {
      font-size: 36px;
      color: #0f172a;
      margin-bottom: 20px;
      font-weight: bold;
    }
    .area {
      font-size: 24px;
      color: #1e40af;
      margin-bottom: 30px;
    }
    .score {
      font-size: 72px;
      color: #16a34a;
      font-weight: bold;
      margin-bottom: 10px;
    }
    .score-label {
      font-size: 18px;
      color: #64748b;
      margin-bottom: 40px;
    }
    .details {
      display: flex;
      justify-content: space-around;
      margin-bottom: 40px;
    }
    .detail {
      text-align: center;
    }
    .detail-label {
      font-size: 14px;
      color: #64748b;
    }
    .detail-value {
      font-size: 18px;
      color: #0f172a;
      font-weight: bold;
    }
    .certificate-id {
      font-size: 12px;
      color: #94a3b8;
      margin-top: 40px;
    }
    .footer {
      margin-top: 40px;
      font-size: 14px;
      color: #64748b;
    }
  </style>
</head>
<body>
  <div class="certificate">
    <div class="logo">⚖️ SheriaBot</div>
    <div class="title">Certificate of Compliance</div>
    <div class="subtitle">This certifies that</div>
    
    <div class="org-name">${data.organizationName}</div>
    
    <div class="area">has demonstrated compliance with<br><strong>${data.areaName}</strong></div>
    
    <div class="score">${data.score}%</div>
    <div class="score-label">Compliance Score</div>
    
    <div class="details">
      <div class="detail">
        <div class="detail-label">Issued On</div>
        <div class="detail-value">${data.issuedAt.toLocaleDateString('en-KE', { dateStyle: 'long' })}</div>
      </div>
      <div class="detail">
        <div class="detail-label">Valid Until</div>
        <div class="detail-value">${data.validUntil.toLocaleDateString('en-KE', { dateStyle: 'long' })}</div>
      </div>
    </div>
    
    <div class="certificate-id">Certificate ID: ${data.certificateId}</div>
    
    <div class="footer">
      This certificate is issued by SheriaBot and is valid for ${CERTIFICATE_VALIDITY_DAYS} days from the issue date.<br>
      Verify at: sheriabot.com/verify/${data.certificateId}
    </div>
  </div>
</body>
</html>
`;
  }
}

// Export singleton instance
export const complianceTracker = new ComplianceTracker();

// Export class for testing
export { ComplianceTracker };
