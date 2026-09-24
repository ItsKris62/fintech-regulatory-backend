import { PutObjectCommand } from '@aws-sdk/client-s3';
import { customAlphabet } from 'nanoid';
import { r2PrivateClient, r2AuditBucket } from '@/lib/storage/r2-private-client';
import { logger } from '@/utils/logger';

const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 16);

export interface ImmutableAuditRecord {
  id?: string;
  timestamp?: string | Date;
  action: string;
  userId?: string | null;
  organizationId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  details?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  [key: string]: unknown;
}

/**
 * Builds the immutable S3/R2 storage key for an audit event:
 * `audit/{yyyy}/{mm}/{dd}/{eventId}.jsonl`
 */
export function buildAuditStorageKey(date: Date = new Date(), eventId?: string): string {
  const yyyy = date.getUTCFullYear().toString();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const id = eventId || nanoid();
  return `audit/${yyyy}/${mm}/${dd}/${id}.jsonl`;
}

/**
 * Persists an audit event or batch of audit records to the immutable audit bucket:
 * `sheria-bot-audit-immutable/audit/{yyyy}/{mm}/{dd}/{eventId}.jsonl`
 */
export async function writeImmutableAuditRecord(
  records: ImmutableAuditRecord | ImmutableAuditRecord[],
  options?: { eventId?: string; date?: Date }
): Promise<{ key: string; bucket: string }> {
  const date = options?.date || new Date();
  const key = buildAuditStorageKey(date, options?.eventId);
  const items = Array.isArray(records) ? records : [records];

  const jsonlLines = items.map((r) => {
    const recordWithMeta = {
      ...r,
      recordedAt: new Date().toISOString(),
    };
    return JSON.stringify(recordWithMeta);
  });

  const buffer = Buffer.from(jsonlLines.join('\n') + '\n', 'utf-8');

  try {
    await r2PrivateClient.send(
      new PutObjectCommand({
        Bucket: r2AuditBucket,
        Key: key,
        Body: buffer,
        ContentType: 'application/x-ndjson',
        Metadata: {
          'immutable-audit': 'true',
          'record-count': String(items.length),
        },
      })
    );

    logger.info({
      type: 'immutable_audit_log_written',
      bucket: r2AuditBucket,
      key,
      count: items.length,
    });

    return { key, bucket: r2AuditBucket };
  } catch (err: any) {
    logger.error({
      type: 'immutable_audit_log_write_failed',
      bucket: r2AuditBucket,
      key,
      error: err?.message,
    });
    throw err;
  }
}
