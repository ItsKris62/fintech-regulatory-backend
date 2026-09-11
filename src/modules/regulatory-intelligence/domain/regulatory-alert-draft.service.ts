import { TRPCError } from '@trpc/server';
import {
  RegulatoryInformationType,
  RegulatoryMateriality,
  type RegulatoryAlert,
} from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import type { CreateRegulatoryAlertDraftInput } from './types';

/**
 * Maps normalized RegulatoryInformationType to the existing customer Alert category.
 */
function mapInformationTypeToCategory(infoType: RegulatoryInformationType): string {
  switch (infoType) {
    case RegulatoryInformationType.DRAFT_REGULATION:
    case RegulatoryInformationType.CIRCULAR:
    case RegulatoryInformationType.DIRECTIVE:
    case RegulatoryInformationType.GUIDANCE:
      return 'PRUDENTIAL';
    case RegulatoryInformationType.LICENSING_UPDATE:
      return 'LICENSING';
    case RegulatoryInformationType.ENFORCEMENT:
      return 'AML_CFT';
    default:
      return 'GENERAL';
  }
}

/**
 * Maps RegulatoryMateriality to existing Alert severity.
 */
function mapMaterialityToSeverity(materiality: RegulatoryMateriality): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  switch (materiality) {
    case RegulatoryMateriality.LOW:
      return 'LOW';
    case RegulatoryMateriality.HIGH:
      return 'HIGH';
    case RegulatoryMateriality.CRITICAL:
      return 'CRITICAL';
    case RegulatoryMateriality.MEDIUM:
    default:
      return 'MEDIUM';
  }
}

export class RegulatoryAlertDraftService {
  constructor(private readonly prisma: typeof defaultPrisma = defaultPrisma) {}

  /**
   * Creates an inactive draft RegulatoryAlert linked to a verified RegulatorySourceItem.
   * STRICT GUARANTEE:
   * - Sets isActive = false
   * - Creates 0 AlertNotification records
   * - Emits 0 SSE / Redis pubsub messages
   * - Dispatches 0 emails
   * - Idempotency guaranteed via database-unique automationDraftKey
   */
  async createAlertDraft(
    input: CreateRegulatoryAlertDraftInput,
    publishedById: string
  ): Promise<{ alert: RegulatoryAlert; isNew: boolean }> {
    // 1. Check idempotency via automationDraftKey
    const existingDraft = await this.prisma.regulatoryAlert.findUnique({
      where: { automationDraftKey: input.automationDraftKey },
    });

    if (existingDraft) {
      logger.info({
        type: 'regulatory_alert_draft_idempotent_hit',
        automationDraftKey: input.automationDraftKey,
        alertId: existingDraft.id,
      });
      return { alert: existingDraft, isNew: false };
    }

    // 2. Validate source item
    const sourceItem = await this.prisma.regulatorySourceItem.findUnique({
      where: { id: input.sourceItemId },
      include: {
        primarySnapshot: {
          select: { sourceUrl: true },
        },
      },
    });

    if (!sourceItem) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `Regulatory source item "${input.sourceItemId}" not found.`,
      });
    }

    const title = input.title ?? sourceItem.title;
    const summary = input.summary ?? (sourceItem.summary.length > 500 ? `${sourceItem.summary.slice(0, 497)}...` : sourceItem.summary);
    const body = input.body ?? sourceItem.summary;
    const category = input.category ?? mapInformationTypeToCategory(sourceItem.informationType);
    const severity = input.severity ?? mapMaterialityToSeverity(sourceItem.materiality);
    const sourceUrl = input.sourceUrl ?? (sourceItem.primarySnapshot?.sourceUrl ?? null);
    const effectiveDate = input.effectiveDate ? new Date(input.effectiveDate) : sourceItem.effectiveDate;
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;

    // 3. Create draft alert
    const alert = await this.prisma.regulatoryAlert.create({
      data: {
        title,
        summary,
        body,
        sourceUrl,
        jurisdictionCode: sourceItem.jurisdictionCode,
        regulatoryBody: sourceItem.regulator,
        category,
        severity,
        effectiveDate,
        expiresAt,
        isActive: false, // MANDATORY: Must remain false
        publishedById,
        primaryRegulatorySourceItemId: sourceItem.id,
        automationDraftKey: input.automationDraftKey,
      },
    });

    logger.info({
      type: 'regulatory_alert_draft_created',
      alertId: alert.id,
      sourceItemId: sourceItem.id,
      automationDraftKey: input.automationDraftKey,
      isActive: alert.isActive,
    });

    return { alert, isNew: true };
  }
}

export const regulatoryAlertDraftService = new RegulatoryAlertDraftService();
