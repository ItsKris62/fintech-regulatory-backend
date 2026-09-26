import crypto from 'crypto';
import { prisma } from '@/lib/prisma/client';
import { logSecurityEvent, SECURITY_EVENT_TYPES } from './audit.service';
import { logger } from '@/utils/logger';

export interface CreateApiKeyInput {
  userId: string;
  organizationId: string;
  name: string;
  expiresAt?: Date | null;
}

export interface RevokeApiKeyInput {
  keyId: string;
  userId: string;
  organizationId: string;
}

export class ApiKeyService {
  /**
   * Creates a new API key for the user, hashing the secret and logging a SecurityAuditEvent.
   */
  async createApiKey(input: CreateApiKeyInput): Promise<{ id: string; rawKey: string; name: string }> {
    const rawSecret = crypto.randomBytes(32).toString('hex');
    const hashedKey = crypto.createHash('sha256').update(rawSecret).digest('hex');

    const apiKey = await prisma.apiKey.create({
      data: {
        userId: input.userId,
        name: input.name,
        key: hashedKey,
        active: true,
        expiresAt: input.expiresAt ?? null,
      },
    });

    await logSecurityEvent({
      eventType: SECURITY_EVENT_TYPES.API_KEY_CREATED,
      userId: input.userId,
      organizationId: input.organizationId,
      metadata: {
        orgId: input.organizationId,
        resourceId: apiKey.id,
        name: apiKey.name,
      },
    }).catch((err: unknown) => {
      logger.warn({
        type: 'api_key_created_audit_write_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return {
      id: apiKey.id,
      rawKey: `sb_${rawSecret}`,
      name: apiKey.name,
    };
  }

  /**
   * Revokes an existing API key, marking active: false and logging a SecurityAuditEvent.
   */
  async revokeApiKey(input: RevokeApiKeyInput): Promise<{ success: boolean }> {
    const updated = await prisma.apiKey.update({
      where: { id: input.keyId },
      data: { active: false },
    });

    await logSecurityEvent({
      eventType: SECURITY_EVENT_TYPES.API_KEY_REVOKED,
      userId: input.userId,
      organizationId: input.organizationId,
      metadata: {
        orgId: input.organizationId,
        resourceId: updated.id,
      },
    }).catch((err: unknown) => {
      logger.warn({
        type: 'api_key_revoked_audit_write_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return { success: true };
  }
}

export const apiKeyService = new ApiKeyService();
