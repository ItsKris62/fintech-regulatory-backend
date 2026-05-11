import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';

import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

import {
  storageConfig,
  getMaxFileSize,
  getPresignedUrlExpiry,
  isFileTypeAllowed,
} from '@/config/storage.config';

import { logger } from '@/utils/logger';
import { StorageServiceError } from '@/utils/error';

import { context, trace, SpanStatusCode, type Tracer } from '@opentelemetry/api';
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

export interface FileMetadata {
  key: string;
  size: number;
  contentType: string;
  lastModified?: Date;
  etag?: string;
  metadata?: Record<string, string>;
  sha256?: string;
}

export interface UploadOptions {
  contentType?: string;
  metadata?: Record<string, string>;
  /**
   * Aligns with storageConfig.limits.maxFileSize keys:
   * documents | images | exports | default
   */
  category?: keyof typeof storageConfig.limits.maxFileSize;

  /**
   * Overrides global config.storage.security.malwareScan
   * - true: force scan
   * - false: skip scan
   * - undefined: use config default
   */
  malwareScan?: boolean;

  /**
   * If true and category is provided, enforce allowed mime types for that category
   */
  enforceAllowedTypes?: boolean;
}

export interface PresignedUrlOptions {
  expiresIn?: number;
  contentType?: string;
  contentDisposition?: string;
  /**
   * When set, the presigned PUT URL is bound to this exact Content-Length.
   * R2/S3 will reject any PUT whose Content-Length header does not match,
   * preventing clients from uploading files larger than they declared.
   */
  contentLength?: number;
}

export interface MalwareScanResult {
  clean: boolean;
  reason?: string;
  engine?: string;
}

export type MalwareScanner = (input: {
  key: string;
  contentType?: string;
  sha256?: string;
  size?: number;
  buffer?: Buffer;
}) => Promise<MalwareScanResult>;

export interface StorageService {
  uploadBuffer: (key: string, buffer: Buffer, options?: UploadOptions) => Promise<FileMetadata>;
  uploadStream: (
    key: string,
    stream: Readable,
    options: UploadOptions & { contentLength: number }
  ) => Promise<FileMetadata>;

  downloadFile: (key: string) => Promise<Buffer>;
  /** Download only the first `maxBytes` bytes of a file (magic-byte inspection). */
  downloadFileChunk: (key: string, maxBytes: number) => Promise<Buffer>;
  deleteFile: (key: string) => Promise<void>;
  fileExists: (key: string) => Promise<boolean>;
  getFileMetadata: (key: string) => Promise<FileMetadata | null>;
  listFiles: (prefix?: string, maxKeys?: number) => Promise<FileMetadata[]>;
  getPresignedDownloadUrl: (key: string, options?: PresignedUrlOptions) => Promise<string>;
  getPresignedUploadUrl: (key: string, options?: PresignedUrlOptions) => Promise<string>;
}

/* -------------------------------------------------------------------------- */
/*                            Config / Validation                              */
/* -------------------------------------------------------------------------- */

function bucketName(): string {
  return storageConfig.bucket.name;
}

function validateConfigOrThrow(): void {
  const { credentials, bucket, s3Config } = storageConfig;

  const missing: string[] = [];
  if (!credentials.accountId) missing.push('storage.credentials.accountId');
  if (!credentials.accessKeyId) missing.push('storage.credentials.accessKeyId');
  if (!credentials.secretAccessKey) missing.push('storage.credentials.secretAccessKey');
  if (!bucket.name) missing.push('storage.bucket.name');
  if (!s3Config.endpoint) missing.push('storage.s3Config.endpoint');

  if (missing.length) {
    throw new Error(`Storage config missing: ${missing.join(', ')}`);
  }
}

/* -------------------------------------------------------------------------- */
/*                        Exponential Backoff + Jitter                         */
/* -------------------------------------------------------------------------- */

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(
  opName: string,
  fn: () => Promise<T>
): Promise<T> {
  const { maxAttempts, initialDelay, maxDelay, backoffMultiplier } = storageConfig.retry;

  let lastErr: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (attempt === maxAttempts) break;

      const base = Math.min(initialDelay * Math.pow(backoffMultiplier, attempt - 1), maxDelay);
      const jitter = Math.floor(Math.random() * 250);
      const delay = base + jitter;

      logger.warn({
        type: 'storage_retry',
        opName,
        attempt,
        delay,
        error: err?.message,
      });

      await sleep(delay);
    }
  }
  throw lastErr;
}

/* -------------------------------------------------------------------------- */
/*                                 Hashing                                    */
/* -------------------------------------------------------------------------- */

function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function hashStream(input: Readable): { stream: Readable; hashPromise: Promise<string> } {
  const hasher = createHash('sha256');

  let resolve!: (v: string) => void;
  let reject!: (e: any) => void;

  const hashPromise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  input.on('data', (chunk) => hasher.update(chunk));
  input.on('end', () => resolve(hasher.digest('hex')));
  input.on('error', (e) => reject(e));

  return { stream: input, hashPromise };
}

/* -------------------------------------------------------------------------- */
/*                             Malware Hook                                   */
/* -------------------------------------------------------------------------- */

async function runMalwareScanIfEnabled(args: {
  enabled: boolean;
  scanner?: MalwareScanner;
  key: string;
  contentType?: string;
  sha256?: string;
  size?: number;
  buffer?: Buffer;
}) {
  if (!args.enabled) return;

  if (!args.scanner) {
    // In prod, if you truly require malware scanning, fail hard:
    if (storageConfig.security.malwareScan) {
      throw new StorageServiceError('Malware scanning enabled but no scanner is configured');
    }
    logger.warn({ type: 'malware_scan_skipped', key: args.key, reason: 'no_scanner_configured' });
    return;
  }

  const result = await args.scanner({
    key: args.key,
    contentType: args.contentType,
    sha256: args.sha256,
    size: args.size,
    buffer: args.buffer,
  });

  if (!result.clean) {
    throw new StorageServiceError(`Malware scan failed: ${result.reason || 'file flagged'}`);
  }
}

/* -------------------------------------------------------------------------- */
/*                           Limits + Type Checks                              */
/* -------------------------------------------------------------------------- */

function validateUploadOrThrow(args: {
  size: number;
  category?: keyof typeof storageConfig.limits.maxFileSize;
  contentType?: string;
  enforceAllowedTypes?: boolean;
}) {
  const minSize = storageConfig.limits.minFileSize;
  if (args.size < minSize) {
    throw new StorageServiceError(`File too small (${args.size} bytes). Minimum is ${minSize} bytes.`);
  }

  const category = args.category ?? 'default';
  const max = getMaxFileSize(category);
  if (args.size > max) {
    throw new StorageServiceError(`File too large (${args.size} bytes). Max for ${category} is ${max} bytes.`);
  }

  if (
    args.enforceAllowedTypes &&
    args.contentType &&
    category &&
    storageConfig.security.validateContent
  ) {
    // Only enforce if the category exists in allowedFileTypes
    if ((storageConfig.allowedFileTypes as any)[category]) {
      if (!isFileTypeAllowed(args.contentType, category as any)) {
        throw new StorageServiceError(`File type not allowed: ${args.contentType} (category: ${category})`);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                              Service Factory                                */
/* -------------------------------------------------------------------------- */

export function createStorageService(deps?: {
  tracer?: Tracer;
  malwareScanner?: MalwareScanner;
  s3Client?: S3Client;
}): StorageService {
  validateConfigOrThrow();

  const tracer = deps?.tracer ?? trace.getTracer('sheriabot-storage');

  const s3 =
    deps?.s3Client ??
    new S3Client({
      region: storageConfig.s3Config.region,
      endpoint: storageConfig.s3Config.endpoint,
      credentials: {
        accessKeyId: storageConfig.credentials.accessKeyId,
        secretAccessKey: storageConfig.credentials.secretAccessKey,
      },
      forcePathStyle: storageConfig.s3Config.forcePathStyle,
      maxAttempts: storageConfig.retry.maxAttempts,
    });

  const malwareScanner = deps?.malwareScanner;

  async function uploadBuffer(
    key: string,
    buffer: Buffer,
    options: UploadOptions = {}
  ): Promise<FileMetadata> {
    const span = tracer.startSpan('storage.uploadBuffer', {
      attributes: {
        key,
        size: buffer.length,
        contentType: options.contentType ?? '',
        category: options.category ?? 'default',
      },
    });

    return await context.with(trace.setSpan(context.active(), span), async () => {
      const start = Date.now();
      try {
        validateUploadOrThrow({
          size: buffer.length,
          category: options.category,
          contentType: options.contentType,
          enforceAllowedTypes: options.enforceAllowedTypes,
        });

        const sha256 = sha256Buffer(buffer);

        const shouldScan = options.malwareScan ?? storageConfig.security.malwareScan;
        await runMalwareScanIfEnabled({
          enabled: Boolean(shouldScan),
          scanner: malwareScanner,
          key,
          contentType: options.contentType,
          sha256,
          size: buffer.length,
          buffer,
        });

        const metadata: Record<string, string> = {
          ...(options.metadata ?? {}),
          'content-sha256': sha256,
        };

        const cmd = new PutObjectCommand({
          Bucket: bucketName(),
          Key: key,
          Body: buffer,
          ContentType: options.contentType,
          Metadata: metadata,
        });

        await withRetry('PutObject(buffer)', () => s3.send(cmd));

        logger.info({
          type: 'r2_upload_success',
          key,
          size: buffer.length,
          sha256,
          duration: Date.now() - start,
        });

        span.setStatus({ code: SpanStatusCode.OK });
        return {
          key,
          size: buffer.length,
          contentType: options.contentType || 'application/octet-stream',
          metadata,
          sha256,
        };
      } catch (e: any) {
        span.recordException(e);
        span.setStatus({ code: SpanStatusCode.ERROR, message: e?.message });
        logger.error({
          type: 'r2_upload_error',
          key,
          error: e?.message,
          errorMessage: e?.message,
          errorName: e?.name,
          errorCode: e?.Code ?? e?.code,
          httpStatusCode: e?.$metadata?.httpStatusCode,
          requestId: e?.$metadata?.requestId,
          extendedRequestId: e?.$metadata?.extendedRequestId,
          cfRayId: e?.$metadata?.cfId,
          attempts: e?.$metadata?.attempts,
          errorStackHead: typeof e?.stack === 'string' ? e.stack.slice(0, 500) : undefined,
          bucket: bucketName(),
          endpoint: storageConfig.s3Config.endpoint,
        });
        throw new StorageServiceError(`Upload failed: ${e?.message}`);
      } finally {
        span.end();
      }
    });
  }

  async function uploadStream(
    key: string,
    stream: Readable,
    options: UploadOptions & { contentLength: number }
  ): Promise<FileMetadata> {
    const span = tracer.startSpan('storage.uploadStream', {
      attributes: {
        key,
        size: options.contentLength,
        contentType: options.contentType ?? '',
        category: options.category ?? 'default',
      },
    });

    return await context.with(trace.setSpan(context.active(), span), async () => {
      const start = Date.now();
      try {
        validateUploadOrThrow({
          size: options.contentLength,
          category: options.category,
          contentType: options.contentType,
          enforceAllowedTypes: options.enforceAllowedTypes,
        });

        // Compute sha256 while streaming
        const { stream: hashedStream, hashPromise } = hashStream(stream);

        // For streams, we don't know sha256 until upload completes.
        // We return it, and you can persist it in DB.
        const metadata: Record<string, string> = {
          ...(options.metadata ?? {}),
          'content-sha256': 'pending',
        };

        const uploader = new Upload({
          client: s3,
          params: {
            Bucket: bucketName(),
            Key: key,
            Body: hashedStream,
            ContentType: options.contentType,
            Metadata: metadata,
          },
          queueSize: 4,
          partSize: 5 * 1024 * 1024,
          leavePartsOnError: false,
        });

        await withRetry('MultipartUpload(stream)', () => uploader.done());

        const sha256 = await hashPromise;

        // Optional malware scan:
        // With streaming, you usually scan pre-upload (by spooling to temp) or async post-upload.
        // This hook calls scanner without buffer; implement scanner to fetch the object if needed.
        const shouldScan = options.malwareScan ?? storageConfig.security.malwareScan;
        await runMalwareScanIfEnabled({
          enabled: Boolean(shouldScan),
          scanner: malwareScanner,
          key,
          contentType: options.contentType,
          sha256,
          size: options.contentLength,
        });

        logger.info({
          type: 'r2_stream_upload_success',
          key,
          size: options.contentLength,
          sha256,
          duration: Date.now() - start,
        });

        span.setStatus({ code: SpanStatusCode.OK });
        return {
          key,
          size: options.contentLength,
          contentType: options.contentType || 'application/octet-stream',
          metadata,
          sha256,
        };
      } catch (e: any) {
        span.recordException(e);
        span.setStatus({ code: SpanStatusCode.ERROR, message: e?.message });
        logger.error({ type: 'r2_stream_upload_error', key, error: e?.message });
        throw new StorageServiceError(`Streaming upload failed: ${e?.message}`);
      } finally {
        span.end();
      }
    });
  }

  async function downloadFile(key: string): Promise<Buffer> {
    const span = tracer.startSpan('storage.downloadFile', { attributes: { key } });
    return await context.with(trace.setSpan(context.active(), span), async () => {
      try {
        const cmd = new GetObjectCommand({ Bucket: bucketName(), Key: key });
        const response = await withRetry('GetObject', () => s3.send(cmd));

        if (!response.Body) throw new StorageServiceError('No file content received');

        const chunks: Uint8Array[] = [];
        for await (const chunk of response.Body as any) chunks.push(chunk);
        span.setStatus({ code: SpanStatusCode.OK });
        return Buffer.concat(chunks);
      } catch (e: any) {
        span.recordException(e);
        span.setStatus({ code: SpanStatusCode.ERROR, message: e?.message });
        throw new StorageServiceError(`Download failed: ${e?.message}`);
      } finally {
        span.end();
      }
    });
  }

  async function downloadFileChunk(key: string, maxBytes: number): Promise<Buffer> {
    const span = tracer.startSpan('storage.downloadFileChunk', { attributes: { key, maxBytes } });
    return await context.with(trace.setSpan(context.active(), span), async () => {
      try {
        const cmd = new GetObjectCommand({
          Bucket: bucketName(),
          Key: key,
          Range: `bytes=0-${maxBytes - 1}`,
        });
        const response = await withRetry('GetObjectChunk', () => s3.send(cmd));

        if (!response.Body) throw new StorageServiceError('No file content received');

        const chunks: Uint8Array[] = [];
        for await (const chunk of response.Body as any) chunks.push(chunk);
        span.setStatus({ code: SpanStatusCode.OK });
        return Buffer.concat(chunks);
      } catch (e: any) {
        span.recordException(e);
        span.setStatus({ code: SpanStatusCode.ERROR, message: e?.message });
        throw new StorageServiceError(`Chunk download failed: ${e?.message}`);
      } finally {
        span.end();
      }
    });
  }

  async function deleteFile(key: string): Promise<void> {
    const span = tracer.startSpan('storage.deleteFile', { attributes: { key } });
    return await context.with(trace.setSpan(context.active(), span), async () => {
      try {
        const cmd = new DeleteObjectCommand({ Bucket: bucketName(), Key: key });
        await withRetry('DeleteObject', () => s3.send(cmd));
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (e: any) {
        span.recordException(e);
        span.setStatus({ code: SpanStatusCode.ERROR, message: e?.message });
        throw new StorageServiceError(`Delete failed: ${e?.message}`);
      } finally {
        span.end();
      }
    });
  }

  async function fileExists(key: string): Promise<boolean> {
    try {
      const cmd = new HeadObjectCommand({ Bucket: bucketName(), Key: key });
      await withRetry('HeadObject', () => s3.send(cmd));
      return true;
    } catch (e: any) {
      if (e?.name === 'NotFound') return false;
      return false;
    }
  }

  async function getFileMetadata(key: string): Promise<FileMetadata | null> {
    try {
      const cmd = new HeadObjectCommand({ Bucket: bucketName(), Key: key });
      const response = await withRetry('HeadObject', () => s3.send(cmd));
      return {
        key,
        size: response.ContentLength || 0,
        contentType: response.ContentType || 'application/octet-stream',
        lastModified: response.LastModified,
        etag: response.ETag,
        metadata: response.Metadata,
        sha256: response.Metadata?.['content-sha256'],
      };
    } catch (e: any) {
      if (e?.name === 'NotFound') return null;
      logger.error({ type: 'r2_metadata_error', key, error: e?.message });
      return null;
    }
  }

  async function listFiles(prefix?: string, maxKeys = 1000): Promise<FileMetadata[]> {
    const cmd = new ListObjectsV2Command({
      Bucket: bucketName(),
      Prefix: prefix,
      MaxKeys: maxKeys,
    });

    const response = await withRetry('ListObjectsV2', () => s3.send(cmd));

    return (response.Contents || []).map((item) => ({
      key: item.Key || '',
      size: item.Size || 0,
      contentType: 'application/octet-stream',
      lastModified: item.LastModified,
      etag: item.ETag,
    }));
  }

  async function getPresignedDownloadUrl(key: string, options: PresignedUrlOptions = {}) {
    const cmd = new GetObjectCommand({
      Bucket: bucketName(),
      Key: key,
      ResponseContentType: options.contentType,
      ResponseContentDisposition: options.contentDisposition,
    });

    const expiresIn = options.expiresIn ?? getPresignedUrlExpiry('download');
    return getSignedUrl(s3, cmd, { expiresIn });
  }

  async function getPresignedUploadUrl(key: string, options: PresignedUrlOptions = {}) {
    const cmd = new PutObjectCommand({
      Bucket: bucketName(),
      Key: key,
      ContentType: options.contentType,
      // Bind the presigned URL to the declared file size so R2 rejects any
      // PUT whose Content-Length header does not match the signed value.
      ...(options.contentLength !== undefined && { ContentLength: options.contentLength }),
    });

    const expiresIn = options.expiresIn ?? getPresignedUrlExpiry('upload');

    // When ContentLength is present, mark content-length as unhoistable so it
    // becomes part of the signature. Any PUT with a different body size returns
    // 403 SignatureDoesNotMatch from R2/S3.
    const signOptions: Parameters<typeof getSignedUrl>[2] = { expiresIn };
    if (options.contentLength !== undefined) {
      signOptions.unhoistableHeaders = new Set(['content-length']);
    }

    return getSignedUrl(s3, cmd, signOptions);
  }

  return {
    uploadBuffer,
    uploadStream,
    downloadFile,
    downloadFileChunk,
    deleteFile,
    fileExists,
    getFileMetadata,
    listFiles,
    getPresignedDownloadUrl,
    getPresignedUploadUrl,
  };
}

/* -------------------------------------------------------------------------- */
/*                          Fastify DI Plugin                                 */
/* -------------------------------------------------------------------------- */

declare module 'fastify' {
  interface FastifyInstance {
    storage: StorageService;
  }
}

export const storagePlugin = fp(async (app: FastifyInstance) => {
  const service = createStorageService();
  app.decorate('storage', service);
});
