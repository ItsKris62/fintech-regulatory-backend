import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';

export const SECURITY_EVENT_TYPES = {
  MFA_CHALLENGE_ISSUED: 'MFA_CHALLENGE_ISSUED',
  MFA_VERIFY_SUCCESS: 'MFA_VERIFY_SUCCESS',
  MFA_VERIFY_FAILED: 'MFA_VERIFY_FAILED',
  MFA_BACKUP_CODE_USED: 'MFA_BACKUP_CODE_USED',
  MFA_RATE_LIMITED: 'MFA_RATE_LIMITED',
  MFA_ENROLLED: 'MFA_ENROLLED',
  MFA_DISABLED: 'MFA_DISABLED',
  MFA_ENFORCEMENT_BLOCKED: 'MFA_ENFORCEMENT_BLOCKED',
  MFA_ENFORCEMENT_GRACE: 'MFA_ENFORCEMENT_GRACE',
  MFA_CHALLENGE_DECRYPTION_FAILED: 'MFA_CHALLENGE_DECRYPTION_FAILED',
  MFA_STEP_UP_VERIFIED: 'MFA_STEP_UP_VERIFIED',
  MFA_STEP_UP_FAILED: 'MFA_STEP_UP_FAILED',

  // Passkey / WebAuthn events
  PASSKEY_REGISTRATION_STARTED: 'PASSKEY_REGISTRATION_STARTED',
  PASSKEY_REGISTRATION_SUCCESS: 'PASSKEY_REGISTRATION_SUCCESS',
  PASSKEY_REGISTRATION_FAILED: 'PASSKEY_REGISTRATION_FAILED',
  PASSKEY_AUTH_STARTED: 'PASSKEY_AUTH_STARTED',
  PASSKEY_AUTH_SUCCESS: 'PASSKEY_AUTH_SUCCESS',
  PASSKEY_AUTH_FAILED: 'PASSKEY_AUTH_FAILED',
  PASSKEY_REVOKED: 'PASSKEY_REVOKED',
  PASSKEY_RENAMED: 'PASSKEY_RENAMED',
  PASSKEY_RATE_LIMITED: 'PASSKEY_RATE_LIMITED',
  PASSKEY_COUNTER_REGRESSION: 'PASSKEY_COUNTER_REGRESSION',
} as const;

export type SecurityEventType =
  (typeof SECURITY_EVENT_TYPES)[keyof typeof SECURITY_EVENT_TYPES] | string;

export interface LogSecurityEventParams {
  eventType: SecurityEventType;
  userId?: string | null;
  organizationId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
}

const FORBIDDEN_METADATA_KEYS = new Set([
  'code',
  'totpcode',
  'totpsecret',
  'secret',
  'temptoken',
  'token',
  'backupcode',
  'backupcodes',
  'password',
  'currentpassword',
  'newpassword',
  'confirmpassword',
  // Passkey sensitive keys
  'challenge',
  'credentialid',
  'publickey',
  'signature',
  'clientdatajson',
  'authenticatordata',
  'attestationobject',
  'userhandle',
]);

/**
 * Sanitizes metadata to guarantee that no secret keys or sensitive tokens are written to audit logs.
 * Recursively filters nested objects and arrays, guards against circular structures,
 * and caps recursion depth at 10.
 */
export function sanitizeMetadata(metadata?: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;

  const seen = new WeakSet<object>();

  function sanitizeValue(value: unknown, depth: number): unknown {
    if (depth > 10) return '[MaxDepth]';
    if (value === null || typeof value !== 'object') {
      return value;
    }

    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => sanitizeValue(item, depth + 1));
    }

    const obj = value as Record<string, unknown>;
    const sanitizedObj: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(obj)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (FORBIDDEN_METADATA_KEYS.has(normalizedKey)) {
        continue;
      }
      sanitizedObj[key] = sanitizeValue(val, depth + 1);
    }

    return sanitizedObj;
  }

  return sanitizeValue(metadata, 0) as Record<string, unknown>;
}

/**
 * Append-only security audit event logger.
 * Safe, fire-and-forget: Catches any database or write errors and logs to Pino at error level
 * so that audit logging never interrupts core authentication workflows.
 */
export async function logSecurityEvent(params: LogSecurityEventParams): Promise<void> {
  try {
    const sanitizedMeta = sanitizeMetadata(params.metadata);

    await (prisma as any).securityAuditEvent.create({
      data: {
        eventType: params.eventType,
        userId: params.userId ?? null,
        organizationId: params.organizationId ?? null,
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ? params.userAgent.substring(0, 500) : null,
        metadata: sanitizedMeta ?? undefined,
      },
    });

    logger.info({
      type: 'security_audit_event_logged',
      eventType: params.eventType,
      userId: params.userId,
      organizationId: params.organizationId,
    });
  } catch (error: any) {
    logger.error({
      type: 'security_audit_log_failed',
      eventType: params.eventType,
      userId: params.userId,
      error: error?.message,
    });
  }
}
