/**
 * Section 34 Restriction of Processing Service (Kenya DPA 2019)
 *
 * Implements Section 34 of the Kenya Data Protection Act, 2019 and Regulation 12 of the
 * Data Protection (General) Regulations, 2021 (Legal Notice No. 263 of 2021).
 *
 * Statutory Actor: Data Controller (or Data Processor) under the Act.
 * Operational Owner: DPO / privacy lead / authorised compliance administrator.
 *
 * Statutory Scope (Section 34(1)):
 *   A data controller shall restrict processing under four authoritative circumstances:
 *   1. ACCURACY_CONTESTED (s.34(1)(a)):
 *      Accuracy of personal data is contested by the data subject, for a period enabling
 *      the data controller to verify accuracy.
 *   2. DATA_NO_LONGER_REQUIRED_LEGAL_CLAIM (s.34(1)(b)):
 *      Data controller no longer needs personal data for original purpose, but data is required
 *      by the data subject for establishment, exercise or defence of a legal claim.
 *   3. UNLAWFUL_PROCESSING_ERASURE_OPPOSED (s.34(1)(c)):
 *      Processing is unlawful and the data subject opposes erasure, requesting restriction instead.
 *   4. OBJECTION_PENDING_VERIFICATION (s.34(1)(d)):
 *      Data subject has objected to processing pending verification whether legitimate grounds
 *      of the controller override those of the data subject.
 *
 * Processing Permitted During Restriction (Section 34(2)(a)):
 *   Restricted data may only be processed for:
 *   (i)   STORAGE_ONLY (preserving encrypted records);
 *   (ii)  CONSENT_GRANTED (with data subject's explicit consent);
 *   (iii) LEGAL_CLAIMS_DEFENSE (establishment, exercise or defence of legal claims);
 *   (iv)  PROTECTION_OF_RIGHTS (protection of rights of another person);
 *   (v)   PUBLIC_INTEREST (for reasons of public interest).
 *
 * Statutory Pre-Lift Notice (Section 34(2)(b)):
 *   "A data controller or data processor who has restricted processing under this section
 *   shall inform the data subject before the restriction of processing is lifted."
 *
 * Time Limits and Periodic Review (Section 34(3)):
 *   Data controllers and processors must implement mechanisms ensuring time limits for
 *   rectification, erasure, restriction, and periodic review of storage are observed.
 *
 * Optional Processing Blocked by Default:
 *   - AI_QUERYING (interactive Claude LLM inference & RAG queries)
 *   - DIRECT_MARKETING (marketing emails, pilot outreach, newsletters)
 *   - PRODUCT_TELEMETRY (PostHog event capture & analytics)
 *   - POLICY_GENERATION (automated enterprise policy generation)
 *   - GAP_ANALYSIS (document evaluation against regulations)
 *
 * Non-User Data Subject Support:
 *   Applies to registered users (User table) and non-user data subjects (prospects,
 *   newsletter subscribers, pilot applicants, marketing contacts, contact-form submitters)
 *   via durable Contact suppression flags and SuppressionList integration.
 */

import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { SuppressionReason } from '@prisma/client';

export type StatutoryRestrictionReason =
  | 'ACCURACY_CONTESTED'
  | 'DATA_NO_LONGER_REQUIRED_LEGAL_CLAIM'
  | 'UNLAWFUL_PROCESSING_ERASURE_OPPOSED'
  | 'OBJECTION_PENDING_VERIFICATION';

export type Section34PermittedException =
  | 'STORAGE_ONLY'
  | 'CONSENT_GRANTED'
  | 'LEGAL_CLAIMS_DEFENSE'
  | 'PROTECTION_OF_RIGHTS'
  | 'PUBLIC_INTEREST';

export type RestrictedOptionalPurpose =
  | 'AI_QUERYING'
  | 'DIRECT_MARKETING'
  | 'PRODUCT_TELEMETRY'
  | 'POLICY_GENERATION'
  | 'GAP_ANALYSIS';

export type ProcessingActivity = Section34PermittedException | RestrictedOptionalPurpose;

export interface RestrictionRecord {
  status: 'RESTRICTED' | 'LIFTED' | 'NONE';
  restrictedAt?: string;
  reason?: StatutoryRestrictionReason;
  requestId?: string;
  restrictedPurposes: RestrictedOptionalPurpose[];
  liftedAt?: string;
  liftReason?: string;
  dpoAdminId?: string;
  notes?: string;
}

export interface RestrictProcessingInput {
  userId: string;
  reason: StatutoryRestrictionReason;
  requestId: string;
  dpoAdminId?: string;
  restrictedPurposes?: RestrictedOptionalPurpose[];
  notes?: string;
}

export interface LiftRestrictionInput {
  userId: string;
  liftReason: string;
  dpoAdminId?: string;
}

export interface RestrictEmailProcessingInput {
  email: string;
  reason: StatutoryRestrictionReason;
  requestId: string;
  dpoAdminId?: string;
  restrictedPurposes?: RestrictedOptionalPurpose[];
  notes?: string;
}

export interface LiftEmailRestrictionInput {
  email: string;
  liftReason: string;
  dpoAdminId?: string;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class Section34RestrictionService {
  /**
   * Apply Section 34 restriction to a user's data processing
   */
  async restrictProcessing(input: RestrictProcessingInput): Promise<RestrictionRecord> {
    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, email: true, preferences: true, organizationId: true },
    });

    if (!user) {
      throw new Error(`User ${input.userId} not found`);
    }

    const restrictedPurposes: RestrictedOptionalPurpose[] = input.restrictedPurposes ?? [
      'AI_QUERYING',
      'DIRECT_MARKETING',
      'PRODUCT_TELEMETRY',
      'POLICY_GENERATION',
      'GAP_ANALYSIS',
    ];

    const restrictionRecord: RestrictionRecord = {
      status: 'RESTRICTED',
      restrictedAt: new Date().toISOString(),
      reason: input.reason,
      requestId: input.requestId,
      restrictedPurposes,
      dpoAdminId: input.dpoAdminId,
      notes: input.notes,
    };

    const currentPreferences = (user.preferences as Record<string, unknown>) ?? {};
    const updatedPreferences = {
      ...currentPreferences,
      section34Restriction: restrictionRecord,
    };

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: {
          preferences: updatedPreferences as any,
        },
      }),
      prisma.auditLog.create({
        data: {
          userId: input.dpoAdminId ?? user.id,
          action: 'dsr_processing_restricted',
          entityType: 'User',
          entityId: user.id,
          metadata: {
            reason: input.reason,
            requestId: input.requestId,
            restrictedPurposes,
            organizationId: user.organizationId,
          },
        },
      }),
    ]);

    logger.info({
      type: 'section34_processing_restricted',
      userId: user.id,
      reason: input.reason,
      requestId: input.requestId,
    });

    return restrictionRecord;
  }

  /**
   * Lift a Section 34 restriction following statutory review and pre-lift notification (s.34(2)(b))
   */
  async liftRestriction(input: LiftRestrictionInput): Promise<RestrictionRecord> {
    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, preferences: true, organizationId: true },
    });

    if (!user) {
      throw new Error(`User ${input.userId} not found`);
    }

    const currentPreferences = (user.preferences as Record<string, unknown>) ?? {};
    const existingRestriction = (currentPreferences.section34Restriction as RestrictionRecord) ?? {
      status: 'NONE',
      restrictedPurposes: [],
    };

    const updatedRestriction: RestrictionRecord = {
      ...existingRestriction,
      status: 'LIFTED',
      liftedAt: new Date().toISOString(),
      liftReason: input.liftReason,
      dpoAdminId: input.dpoAdminId,
    };

    const updatedPreferences = {
      ...currentPreferences,
      section34Restriction: updatedRestriction,
    };

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: {
          preferences: updatedPreferences as any,
        },
      }),
      prisma.auditLog.create({
        data: {
          userId: input.dpoAdminId ?? user.id,
          action: 'dsr_processing_restriction_lifted',
          entityType: 'User',
          entityId: user.id,
          metadata: {
            liftReason: input.liftReason,
            organizationId: user.organizationId,
          },
        },
      }),
    ]);

    logger.info({
      type: 'section34_restriction_lifted',
      userId: user.id,
      liftReason: input.liftReason,
    });

    return updatedRestriction;
  }

  /**
   * Apply Section 34 restriction by email address (covering non-user data subjects:
   * prospects, newsletter subscribers, pilot applicants, marketing contacts, contact leads, former users).
   */
  async restrictProcessingForEmail(input: RestrictEmailProcessingInput): Promise<RestrictionRecord> {
    const normalized = normalizeEmail(input.email);
    const restrictedPurposes: RestrictedOptionalPurpose[] = input.restrictedPurposes ?? [
      'AI_QUERYING',
      'DIRECT_MARKETING',
      'PRODUCT_TELEMETRY',
      'POLICY_GENERATION',
      'GAP_ANALYSIS',
    ];

    const restrictionRecord: RestrictionRecord = {
      status: 'RESTRICTED',
      restrictedAt: new Date().toISOString(),
      reason: input.reason,
      requestId: input.requestId,
      restrictedPurposes,
      dpoAdminId: input.dpoAdminId,
      notes: input.notes,
    };

    // 1. If User exists with this email, apply user-level preference restriction
    const existingUser = await prisma.user.findUnique({
      where: { email: normalized },
      select: { id: true, preferences: true, organizationId: true },
    });

    if (existingUser) {
      const currentPreferences = (existingUser.preferences as Record<string, unknown>) ?? {};
      await prisma.user.update({
        where: { id: existingUser.id },
        data: {
          preferences: {
            ...currentPreferences,
            section34Restriction: restrictionRecord,
          } as any,
        },
      });
    }

    // 2. Durable entry in SuppressionList with Section 34 metadata
    await prisma.suppressionList.upsert({
      where: { email: normalized },
      create: {
        email: normalized,
        reason: SuppressionReason.MANUAL,
        addedById: input.dpoAdminId ?? null,
        metadata: {
          section34Restriction: restrictionRecord,
        } as any,
      },
      update: {
        reason: SuppressionReason.MANUAL,
        metadata: {
          section34Restriction: restrictionRecord,
        } as any,
      },
    });

    // 3. Update Contact rows with suppression flags
    await prisma.contact.updateMany({
      where: { email: normalized, deletedAt: null },
      data: {
        suppressedAt: new Date(),
        suppressedReason: SuppressionReason.MANUAL,
      },
    });

    // 4. Record audit log
    await prisma.auditLog.create({
      data: {
        userId: input.dpoAdminId ?? existingUser?.id ?? null,
        action: 'dsr_email_processing_restricted',
        entityType: 'DataSubject',
        entityId: normalized,
        metadata: {
          email: normalized,
          isUser: Boolean(existingUser),
          reason: input.reason,
          requestId: input.requestId,
          restrictedPurposes,
        },
      },
    });

    logger.info({
      type: 'section34_email_processing_restricted',
      email: normalized,
      isUser: Boolean(existingUser),
      reason: input.reason,
      requestId: input.requestId,
    });

    return restrictionRecord;
  }

  /**
   * Lift a Section 34 restriction for an email address (following s.34(2)(b) pre-lift notification)
   */
  async liftRestrictionForEmail(input: LiftEmailRestrictionInput): Promise<RestrictionRecord> {
    const normalized = normalizeEmail(input.email);

    const existingUser = await prisma.user.findUnique({
      where: { email: normalized },
      select: { id: true, preferences: true },
    });

    if (existingUser) {
      await this.liftRestriction({
        userId: existingUser.id,
        liftReason: input.liftReason,
        dpoAdminId: input.dpoAdminId,
      });
    }

    const suppressionRecord = await prisma.suppressionList.findUnique({
      where: { email: normalized },
      select: { metadata: true },
    });

    const meta = (suppressionRecord?.metadata as Record<string, unknown>) ?? {};
    const existingRestriction = (meta.section34Restriction as RestrictionRecord) ?? {
      status: 'NONE',
      restrictedPurposes: [],
    };

    const liftedRecord: RestrictionRecord = {
      ...existingRestriction,
      status: 'LIFTED',
      liftedAt: new Date().toISOString(),
      liftReason: input.liftReason,
      dpoAdminId: input.dpoAdminId,
    };

    await prisma.suppressionList.updateMany({
      where: { email: normalized },
      data: {
        metadata: {
          ...meta,
          section34Restriction: liftedRecord,
        } as any,
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: input.dpoAdminId ?? existingUser?.id ?? null,
        action: 'dsr_email_processing_restriction_lifted',
        entityType: 'DataSubject',
        entityId: normalized,
        metadata: {
          email: normalized,
          liftReason: input.liftReason,
        },
      },
    });

    logger.info({
      type: 'section34_email_restriction_lifted',
      email: normalized,
      liftReason: input.liftReason,
    });

    return liftedRecord;
  }

  /**
   * Retrieve current Section 34 restriction status for a user
   */
  async getRestrictionStatus(userId: string): Promise<RestrictionRecord> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { preferences: true },
    });

    if (!user) {
      return { status: 'NONE', restrictedPurposes: [] };
    }

    const preferences = (user.preferences as Record<string, unknown>) ?? {};
    return (preferences.section34Restriction as RestrictionRecord) ?? { status: 'NONE', restrictedPurposes: [] };
  }

  /**
   * Retrieve current Section 34 restriction status for an email (user or non-user data subject)
   */
  async getRestrictionStatusForEmail(email: string): Promise<RestrictionRecord> {
    const normalized = normalizeEmail(email);

    // 1. Check User table
    const user = await prisma.user.findUnique({
      where: { email: normalized },
      select: { preferences: true },
    });

    if (user?.preferences) {
      const prefs = user.preferences as Record<string, unknown>;
      const userRestriction = prefs.section34Restriction as RestrictionRecord | undefined;
      if (userRestriction && userRestriction.status === 'RESTRICTED') {
        return userRestriction;
      }
    }

    // 2. Check SuppressionList
    const suppression = await prisma.suppressionList.findUnique({
      where: { email: normalized },
      select: { metadata: true },
    });

    if (suppression?.metadata) {
      const meta = suppression.metadata as Record<string, unknown>;
      const suppressionRestriction = meta.section34Restriction as RestrictionRecord | undefined;
      if (suppressionRestriction && suppressionRestriction.status === 'RESTRICTED') {
        return suppressionRestriction;
      }
    }

    return { status: 'NONE', restrictedPurposes: [] };
  }

  /**
   * Check whether a specific processing activity is permitted for a user
   */
  async isProcessingPermitted(userId: string, activity: ProcessingActivity): Promise<{ permitted: boolean; reason?: string }> {
    // Section 34(2)(a) Statutory Exceptions: Storage, Consent, Legal Claims Defense, Protection of Rights, and Public Interest are ALWAYS permitted
    if (
      activity === 'STORAGE_ONLY' ||
      activity === 'CONSENT_GRANTED' ||
      activity === 'LEGAL_CLAIMS_DEFENSE' ||
      activity === 'PROTECTION_OF_RIGHTS' ||
      activity === 'PUBLIC_INTEREST'
    ) {
      return { permitted: true };
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { preferences: true },
    });

    if (!user) {
      return { permitted: false, reason: 'User not found' };
    }

    const preferences = (user.preferences as Record<string, unknown>) ?? {};
    const restriction = preferences.section34Restriction as RestrictionRecord | undefined;

    if (restriction && restriction.status === 'RESTRICTED') {
      if (restriction.restrictedPurposes.includes(activity as RestrictedOptionalPurpose)) {
        return {
          permitted: false,
          reason: `Processing halted pursuant to Section 34 restriction (Reason: ${restriction.reason}, Request: ${restriction.requestId})`,
        };
      }
    }

    return { permitted: true };
  }

  /**
   * Check whether a specific processing activity is permitted for an email (user or non-user data subject)
   */
  async isProcessingPermittedForEmail(email: string, activity: ProcessingActivity): Promise<{ permitted: boolean; reason?: string }> {
    // Section 34(2)(a) Statutory Exceptions
    if (
      activity === 'STORAGE_ONLY' ||
      activity === 'CONSENT_GRANTED' ||
      activity === 'LEGAL_CLAIMS_DEFENSE' ||
      activity === 'PROTECTION_OF_RIGHTS' ||
      activity === 'PUBLIC_INTEREST'
    ) {
      return { permitted: true };
    }

    const restriction = await this.getRestrictionStatusForEmail(email);
    if (restriction.status === 'RESTRICTED') {
      if (restriction.restrictedPurposes.includes(activity as RestrictedOptionalPurpose)) {
        return {
          permitted: false,
          reason: `Processing halted pursuant to Section 34 restriction for ${normalizeEmail(email)} (Reason: ${restriction.reason}, Request: ${restriction.requestId})`,
        };
      }
    }

    return { permitted: true };
  }

  /**
   * Guard assertion: throws an error if processing is restricted for a user
   */
  async assertProcessingPermitted(userId: string, activity: ProcessingActivity): Promise<void> {
    const check = await this.isProcessingPermitted(userId, activity);
    if (!check.permitted) {
      throw new Error(check.reason ?? 'Processing restricted pursuant to DPA Section 34');
    }
  }

  /**
   * Guard assertion: throws an error if processing is restricted for an email
   */
  async assertProcessingPermittedForEmail(email: string, activity: ProcessingActivity): Promise<void> {
    const check = await this.isProcessingPermittedForEmail(email, activity);
    if (!check.permitted) {
      throw new Error(check.reason ?? 'Processing restricted pursuant to DPA Section 34');
    }
  }
}

export const section34RestrictionService = new Section34RestrictionService();
