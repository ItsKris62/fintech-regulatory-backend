/**
 * Consent Service
 *
 * DPA 2019-compliant consent tracking for the marketing module.
 *
 * Key invariants:
 *   - ConsentRecord + Contact update always happen in a single $transaction.
 *     If either fails, both roll back — no orphaned audit records.
 *
 *   - IMPORTED_LEGITIMATE_INTEREST → ContactConsentStatus.PENDING
 *     (NOT GRANTED). Under the legitimate-interest lawful basis, contact is
 *     sent one email with a clear opt-out option. Only if they do not opt out
 *     is consent considered valid. Marking as GRANTED at import time would be
 *     a DPA 2019 violation.
 *
 *   - REVOKED → ContactConsentStatus.REVOKED + SuppressionList entry.
 *     An explicit revocation is operationally equivalent to an unsubscribe —
 *     the contact must not receive future sends.
 *
 *   - UPDATED → records audit trail + updates consentTimestamp, but does NOT
 *     change consentStatus (the action represents a preference update, not a
 *     consent status transition).
 */

import { ConsentAction, ContactConsentStatus, SuppressionReason } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { suppress } from './suppression.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecordConsentParams {
  contactId:  string;
  action:     ConsentAction;
  /** Human-readable source label, e.g. 'csv_import', 'web_form', 'api', 'email_unsubscribe' */
  source:     string;
  ipAddress?: string;
  userAgent?: string;
  metadata?:  Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Mapping: ConsentAction → ContactConsentStatus
//
// Only actions that represent a definitive status transition are mapped.
// UPDATED is intentionally absent — it signals a preference change, not a
// consent-status transition. The transaction still updates consentTimestamp.
// ---------------------------------------------------------------------------

const ACTION_TO_STATUS: Partial<Record<ConsentAction, ContactConsentStatus>> = {
  [ConsentAction.GRANTED]: ContactConsentStatus.GRANTED,
  [ConsentAction.REVOKED]: ContactConsentStatus.REVOKED,
  // DPA 2019 critical: legitimate-interest imports start as PENDING, not GRANTED.
  // The first email must carry an unambiguous opt-out mechanism. Status is only
  // promoted to GRANTED if the contact engages without opting out.
  [ConsentAction.IMPORTED_LEGITIMATE_INTEREST]: ContactConsentStatus.PENDING,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a consent action for a contact.
 *
 * Atomically:
 *   1. Updates Contact.consentStatus (if the action maps to a status transition)
 *      and Contact.consentTimestamp + Contact.consentSource.
 *   2. Creates a ConsentRecord for the audit trail.
 *
 * Post-transaction (non-atomic, intentional):
 *   - If action === REVOKED, calls suppress() which writes to SuppressionList
 *     and sets the Redis suppression cache. Redis cannot participate in a Prisma
 *     transaction, so this step runs after the DB transaction commits.
 *
 * @throws If the contact does not exist (Prisma P2025 from contact.update).
 */
export async function recordConsent(params: RecordConsentParams): Promise<void> {
  const { contactId, action, source, ipAddress, userAgent, metadata } = params;

  const newStatus = ACTION_TO_STATUS[action]; // undefined for UPDATED

  // Pre-fetch contact email before the transaction — needed for REVOKED suppression.
  // Email is fetched outside the transaction to avoid interactive-transaction complexity.
  let contactEmail: string | null = null;
  if (action === ConsentAction.REVOKED) {
    const contact = await prisma.contact.findUnique({
      where:  { id: contactId },
      select: { email: true },
    });
    contactEmail = contact?.email ?? null;
  }

  // Atomic: Contact update + ConsentRecord insert in a single DB transaction.
  // If either operation fails, both roll back — no orphaned audit records.
  await prisma.$transaction([
    prisma.contact.update({
      where: { id: contactId },
      data: {
        consentTimestamp: new Date(),
        consentSource:    source,
        ...(newStatus !== undefined ? { consentStatus: newStatus } : {}),
      },
    }),
    prisma.consentRecord.create({
      data: {
        contactId,
        action,
        source,
        ipAddress,
        userAgent,
        metadata:   metadata ?? undefined,
        occurredAt: new Date(),
      },
    }),
  ]);

  // Log contactId at info level — never the raw email (PII)
  logger.info({ type: 'marketing_consent_recorded', contactId, action });

  // Post-transaction: REVOKED → add to SuppressionList + Redis cache.
  // Runs outside the Prisma transaction because Redis cannot be part of it.
  // The consent status is already persisted at this point; suppression failure
  // is logged but does not roll back the consent record.
  if (action === ConsentAction.REVOKED && contactEmail) {
    try {
      await suppress(contactEmail, SuppressionReason.UNSUBSCRIBED);
    } catch (err: unknown) {
      // Non-fatal — consent is recorded; suppression will be enforced on next
      // isSuppressed() call which falls back to DB (consentStatus = REVOKED).
      logger.warn({
        type:      'marketing_consent_suppression_failed',
        contactId,
        error:     err instanceof Error ? err.message : String(err),
      });
    }
  }
}
