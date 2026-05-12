import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';

import { logger } from '@/utils/logger';

interface ComputeContentHashParams {
  s3Client: S3Client;
  bucket: string;
  key: string;
  expectedSize: number;
  context: {
    organizationId: string;
    documentId: string;
  };
}

interface ContentHashResult {
  hash: string;
  bytesRead: number;
  durationMs: number;
}

type HashChunk = Buffer | Uint8Array | string;

function toBuffer(chunk: HashChunk): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk);
  return Buffer.from(chunk);
}

/**
 * Streams an R2 object through SHA-256 without buffering the entire object.
 * Throws if the object cannot be fetched or the byte count does not match.
 */
export async function computeObjectContentHash(
  params: ComputeContentHashParams,
): Promise<ContentHashResult> {
  const { s3Client, bucket, key, expectedSize, context } = params;
  const startedAt = Date.now();

  const response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

  if (!response.Body) {
    throw new Error('Empty body received from R2 GetObject');
  }

  const stream = response.Body as AsyncIterable<HashChunk>;
  const hash = createHash('sha256');
  let bytesRead = 0;

  for await (const chunk of stream) {
    const buffer = toBuffer(chunk);
    hash.update(buffer);
    bytesRead += buffer.length;
  }

  if (bytesRead !== expectedSize) {
    logger.warn({
      type: 'vault.content_hash.size_mismatch',
      organizationId: context.organizationId,
      documentId: context.documentId,
      bucket,
      key,
      expectedSize,
      bytesRead,
    });
    throw new Error(`Streamed byte count ${bytesRead} does not match expected ${expectedSize}`);
  }

  const durationMs = Date.now() - startedAt;
  const digest = hash.digest('hex');

  logger.info({
    type: 'vault.content_hash.computed',
    organizationId: context.organizationId,
    documentId: context.documentId,
    bucket,
    bytesRead,
    durationMs,
  });

  return { hash: digest, bytesRead, durationMs };
}
