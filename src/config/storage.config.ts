import { appConfig } from './app.config';
import { randomUUID } from 'node:crypto';

/**
 * Storage configuration for Cloudflare R2
 * S3-compatible object storage for legal documents and files
 */
export const storageConfig = {
  /**
   * Cloudflare R2 credentials
   */
  credentials: {
    accountId: appConfig.storage.accountId,
    accessKeyId: appConfig.storage.accessKeyId,
    secretAccessKey: appConfig.storage.secretAccessKey,
  },

  /**
   * Bucket configuration
   */
  bucket: {
    name: appConfig.storage.bucketName,
    region: 'auto', // R2 handles region automatically
    publicUrl: appConfig.storage.publicUrl,
  },

  /**
   * S3 client configuration
   */
  s3Config: {
    endpoint: `https://${appConfig.storage.accountId}.r2.cloudflarestorage.com`,
    region: 'auto',
    forcePathStyle: false, // Use virtual-hosted-style URLs
    signatureVersion: 'v4',
  },

  /**
   * File upload limits
   */
  limits: {
    // Maximum file size (bytes)
    maxFileSize: {
      documents: 50 * 1024 * 1024, // 50 MB for legal/regulatory documents
      images: 5 * 1024 * 1024, // 5 MB for images
      exports: 50 * 1024 * 1024, // 50 MB for exports
      vault: 25 * 1024 * 1024, // 25 MB for user vault documents
      default: 10 * 1024 * 1024, // 10 MB default
    },

    // Maximum number of files per upload
    maxFiles: 10,

    // Maximum total upload size (bytes)
    maxTotalSize: 100 * 1024 * 1024, // 100 MB

    // Minimum file size (bytes) - prevent empty files
    minFileSize: 1024, // 1 KB
  },

  /**
   * Allowed file types by category
   */
  allowedFileTypes: {
    documents: {
      mimeTypes: [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ],
      extensions: ['.pdf', '.doc', '.docx'],
      description: 'PDF, Word documents',
    },
    images: {
      mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      extensions: ['.jpg', '.jpeg', '.png', '.webp'],
      description: 'JPEG, PNG, WebP images',
    },
    exports: {
      mimeTypes: [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'text/markdown',
      ],
      extensions: ['.pdf', '.docx', '.xlsx', '.md'],
      description: 'PDF, Word, Excel, Markdown',
    },
    vault: {
      mimeTypes: [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'text/csv',
        'image/png',
        'image/jpeg',
      ],
      extensions: ['.pdf', '.doc', '.docx', '.xlsx', '.csv', '.png', '.jpg', '.jpeg'],
      description: 'PDF, Word, Excel, CSV, PNG, JPG',
    },
  },

  /**
   * File storage paths (prefixes)
   */
  paths: {
    // Legal documents from regulators
    legalDocuments: 'legal-documents/',

    // Generated policy exports
    policyExports: 'policy-exports/',

    // Compliance checklist exports
    checklistExports: 'checklist-exports/',

    // User uploads (evidence, attachments)
    userUploads: 'user-uploads/',

    // Organization logos
    logos: 'logos/',

    // System files
    system: 'system/',

    // Temporary files (auto-deleted after 24 hours)
    temp: 'temp/',

    // Organisation-scoped vault documents (org compliance document storage)
    vault: 'vault/',
  },

  /**
   * Presigned URL configuration
   */
  presignedUrls: {
    // Default expiration time (seconds)
    defaultExpiry: 3600, // 1 hour

    // Expiration by use case
    expiry: {
      download: 3600, // 1 hour for downloads
      upload: 300, // 5 minutes for uploads
      view: 86400, // 24 hours for viewing
      share: 604800, // 7 days for sharing
    },

    // Include content-disposition header to force download
    forceDownload: true,
  },

  /**
   * File naming configuration
   */
  naming: {
    // Use UUID-based filenames for security
    useUUID: true,

    // Preserve original filename in metadata
    preserveOriginalName: true,

    // Sanitize filenames (remove special characters)
    sanitize: true,

    // File naming pattern: {timestamp}-{uuid}-{original}
    pattern: '{timestamp}-{uuid}',

    // Maximum filename length
    maxFilenameLength: 100,
  },

  /**
   * Metadata configuration
   */
  metadata: {
    // Include custom metadata in S3 objects
    enabled: true,

    // Standard metadata fields
    fields: {
      uploadedBy: 'x-amz-meta-uploaded-by',
      uploadedAt: 'x-amz-meta-uploaded-at',
      originalName: 'x-amz-meta-original-name',
      documentType: 'x-amz-meta-document-type',
      organizationId: 'x-amz-meta-organization-id',
      contentHash: 'x-amz-meta-content-hash',
    },
  },

  /**
   * CDN configuration (if using Cloudflare CDN)
   */
  cdn: {
    // Enable CDN for public files
    enabled: appConfig.isProduction,

    // Cache control headers
    cacheControl: {
      documents: 'public, max-age=31536000, immutable', // 1 year
      exports: 'private, max-age=3600', // 1 hour
      images: 'public, max-age=604800', // 1 week
      temp: 'no-cache, no-store, must-revalidate',
    },
  },

  /**
   * Security configuration
   */
  security: {
    // Validate file content (not just extension)
    validateContent: true,

    // Scan for malware (if using external service)
    malwareScan: appConfig.malwareScanEnabled,

    // Encrypt at rest
    encryption: {
      enabled: true,
      algorithm: 'AES256',
    },

    // CORS configuration
    cors: {
      allowedOrigins: [appConfig.frontendUrl],
      allowedMethods: ['GET', 'HEAD', 'PUT', 'POST'],
      allowedHeaders: ['*'],
      maxAge: 3600,
    },
  },

  /**
   * Lifecycle rules for automatic cleanup
   */
  lifecycle: {
    // Enable lifecycle management
    enabled: appConfig.isProduction,

    // Rules
    rules: {
      // Delete temp files after 1 day
      deleteTempFiles: {
        prefix: 'temp/',
        expirationDays: 1,
      },

      // Move old exports to cheaper storage after 30 days
      archiveOldExports: {
        prefix: 'policy-exports/',
        transitionDays: 30,
        storageClass: 'GLACIER',
      },
    },
  },

  /**
   * Retry configuration for upload failures
   */
  retry: {
    maxAttempts: 3,
    initialDelay: 1000, // ms
    maxDelay: 5000, // ms
    backoffMultiplier: 2,
  },

  /**
   * Logging configuration
   */
  logging: {
    // Log all uploads
    logUploads: true,

    // Log all downloads
    logDownloads: appConfig.isProduction,

    // Log deletions
    logDeletions: true,

    // Log access errors
    logErrors: true,
  },
} as const;

/**
 * Get maximum file size for category
 * @param category File category
 * @returns Maximum file size in bytes
 */
export function getMaxFileSize(category: keyof typeof storageConfig.limits.maxFileSize): number {
  return storageConfig.limits.maxFileSize[category] || storageConfig.limits.maxFileSize.default;
}

/**
 * Check if file type is allowed
 * @param mimeType File MIME type
 * @param category File category
 * @returns true if allowed
 */
export function isFileTypeAllowed(
  mimeType: string,
  category: keyof typeof storageConfig.allowedFileTypes
): boolean {
  const allowed = storageConfig.allowedFileTypes[category];
  return (allowed?.mimeTypes as readonly string[] | undefined)?.includes(mimeType) ?? false;
}

/**
 * Check if file extension is allowed
 * @param extension File extension (with dot)
 * @param category File category
 * @returns true if allowed
 */
export function isExtensionAllowed(
  extension: string,
  category: keyof typeof storageConfig.allowedFileTypes
): boolean {
  const allowed = storageConfig.allowedFileTypes[category];
  return (allowed?.extensions as readonly string[] | undefined)?.includes(extension.toLowerCase()) ?? false;
}

/**
 * Generate unique filename
 * @param originalName Original filename
 * @param preserveExtension Whether to preserve file extension
 * @returns Unique filename
 */
export function generateUniqueFilename(
  originalName: string,
  preserveExtension: boolean = true
): string {
  const uuid = randomUUID();

  if (preserveExtension && originalName.includes('.')) {
    const extension = originalName.substring(originalName.lastIndexOf('.')).toLowerCase();
    return `${uuid}${extension}`;
  }

  return uuid;
}

/**
 * Get full S3 key for file
 * @param category File category
 * @param filename Filename
 * @returns Full S3 key
 */
export function getFileKey(
  category: keyof typeof storageConfig.paths,
  filename: string
): string {
  return `${storageConfig.paths[category]}${filename}`;
}

/**
 * Get public URL for file
 * @param key S3 key
 * @returns Public URL
 */
export function getPublicUrl(key: string): string {
  return `${storageConfig.bucket.publicUrl}/${key}`;
}

/**
 * Get presigned URL expiry time
 * @param useCase Use case for URL
 * @returns Expiry time in seconds
 */
export function getPresignedUrlExpiry(
  useCase: keyof typeof storageConfig.presignedUrls.expiry
): number {
  return (
    storageConfig.presignedUrls.expiry[useCase] || storageConfig.presignedUrls.defaultExpiry
  );
}

/**
 * Sanitize filename (remove special characters)
 * @param filename Original filename
 * @returns Sanitized filename
 */
export function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9.-]/g, '_') // Replace special chars with underscore
    .replace(/_{2,}/g, '_') // Replace multiple underscores with single
    .substring(0, storageConfig.naming.maxFilenameLength); // Limit length
}

/**
 * Calculate retry delay with exponential backoff
 * @param attemptNumber Current attempt number (1-indexed)
 * @returns Delay in milliseconds
 */
export function getRetryDelay(attemptNumber: number): number {
  const { initialDelay, maxDelay, backoffMultiplier } = storageConfig.retry;

  const delay = initialDelay * Math.pow(backoffMultiplier, attemptNumber - 1);
  return Math.min(delay, maxDelay);
}

/**
 * Export type
 */
export type StorageConfig = typeof storageConfig;
