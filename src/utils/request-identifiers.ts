import { createHash } from 'crypto';

/**
 * Hash an IP address before using it in logs or Redis keys.
 */
export function hashIp(ip: string | undefined): string {
  if (!ip) return 'unknown';
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}

export function revokedBearerTokenKey(token: string): string {
  return `sheriabot:revoked_bearer:${hashToken(token)}`;
}
