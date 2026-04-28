import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { nanoid } from 'nanoid';
import { r2PrivateClient, r2PrivateBucket } from '@/lib/storage/r2-private-client';
import { logger } from '@/utils/logger';
import { InternalServerError } from '@/utils/error';

export interface CsvUploadResult {
  url: string;
  expiresAt: Date;
  storageKey: string;
}

export function escapeCsvField(
  value: string | number | boolean | null | undefined,
): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (/[,"\r\n]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

export function buildCsvBuffer(
  headers: string[],
  rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null | undefined>>,
): Buffer {
  const headerLine = headers.map(escapeCsvField).join(',');
  const rowLines = rows.map((row) => row.map(escapeCsvField).join(','));
  const csvString = [headerLine, ...rowLines].join('\r\n');
  // UTF-8 BOM at byte offset 0 so Excel renders non-ASCII characters correctly
  return Buffer.from('﻿' + csvString, 'utf-8');
}

export async function uploadCsvToR2(
  buffer: Buffer,
  keyPrefix: string,
  ttlSeconds: number,
): Promise<CsvUploadResult> {
  const clampedTtl = Math.min(3600, Math.max(60, ttlSeconds));
  const id = nanoid(12);
  const storageKey = `exports/${keyPrefix}/${id}.csv`;

  try {
    await r2PrivateClient.send(
      new PutObjectCommand({
        Bucket: r2PrivateBucket,
        Key: storageKey,
        Body: buffer,
        ContentType: 'text/csv; charset=utf-8',
        ContentDisposition: `attachment; filename="${keyPrefix}-${id}.csv"`,
      }),
    );

    const url = await getSignedUrl(
      r2PrivateClient,
      new GetObjectCommand({
        Bucket: r2PrivateBucket,
        Key: storageKey,
        ResponseContentType: 'text/csv; charset=utf-8',
        ResponseContentDisposition: `attachment; filename="${keyPrefix}-${id}.csv"`,
      }),
      { expiresIn: clampedTtl },
    );

    const expiresAt = new Date(Date.now() + clampedTtl * 1000);

    logger.info({
      type: 'csv_export_uploaded',
      keyPrefix,
      byteSize: buffer.length,
      expiresAt,
    });

    return { url, expiresAt, storageKey };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ type: 'csv_export_upload_failed', keyPrefix, error: message });
    throw new InternalServerError('Failed to generate CSV export. Please try again.');
  }
}
