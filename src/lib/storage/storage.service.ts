import { createStorageService, FileMetadata } from './client';
import { storageConfig, isFileTypeAllowed, generateUniqueFilename, getMaxFileSize, getPublicUrl } from '@/config/storage.config';
import { logger } from '@/utils/logger';
import { StorageServiceError, ValidationError } from '@/utils/error';
import { getMimeType } from '@/utils/helpers';

/**
 * File upload result
 */
export interface FileUploadResult {
  key: string;
  url: string;
  size: number;
  contentType: string;
  metadata?: Record<string, string>;
}

// Singleton storage client instance
const storageClient = createStorageService();

/**
 * Storage Service
 * High-level file storage operations with validation
 */
export class StorageService {
  /**
   * Validate file before upload
   * @param fileBuffer File buffer
   * @param filename Original filename
   * @param category File category
   */
  private validateFile(
    fileBuffer: Buffer,
    filename: string,
    category: 'documents' | 'images' | 'exports'
  ): void {
    // Get file extension and content type
    const extension = filename.split('.').pop()?.toLowerCase() || '';
    const contentType = getMimeType(extension);

    // Check if file type is allowed
    if (!isFileTypeAllowed(contentType, category)) {
      throw new ValidationError(
        `File type .${extension} is not allowed for ${category}s`
      );
    }

    // Check file size
    const maxSize = getMaxFileSize(category);
    if (fileBuffer.length > maxSize) {
      throw new ValidationError(
        `File size ${(fileBuffer.length / 1024 / 1024).toFixed(2)}MB exceeds maximum ${(maxSize / 1024 / 1024).toFixed(2)}MB`
      );
    }

    // Basic security checks
    if (filename.includes('../') || filename.includes('..\\')) {
      throw new ValidationError('Invalid filename: path traversal detected');
    }
  }

  /**
   * Scan file for malware (placeholder - implement with actual scanner)
   * @param _fileBuffer File buffer
   * @param filename Filename
   */
  private async scanForMalware(
    _fileBuffer: Buffer,
    filename: string
  ): Promise<boolean> {
    // TODO: Implement actual malware scanning
    // Options: ClamAV, VirusTotal API, etc.

    // For now, just do basic checks
    const suspicious = [
      '.exe', '.bat', '.cmd', '.com', '.scr',
      '.vbs', '.js', '.jar', '.msi', '.dll'
    ];

    const extension = filename.split('.').pop()?.toLowerCase() || '';
    if (suspicious.includes(`.${extension}`)) {
      logger.warn({
        type: 'suspicious_file_detected',
        filename,
        extension,
      });
      return false;
    }

    return true;
  }

  /**
   * Upload document (PDF, DOCX)
   * @param fileBuffer File buffer
   * @param filename Original filename
   * @param userId User ID
   * @param metadata Additional metadata
   */
  async uploadDocument(
    fileBuffer: Buffer,
    filename: string,
    userId: string,
    metadata?: Record<string, string>
  ): Promise<FileUploadResult> {
    logger.info({
      type: 'document_upload_started',
      filename,
      size: fileBuffer.length,
      userId,
    });

    try {
      // Validate file
      this.validateFile(fileBuffer, filename, 'documents');

      // Scan for malware (if enabled)
      if (storageConfig.security.malwareScan) {
        const clean = await this.scanForMalware(fileBuffer, filename);
        if (!clean) {
          throw new ValidationError('File failed security scan');
        }
      }

      // Generate unique filename
      const uniqueFilename = generateUniqueFilename(filename);
      const key = `${storageConfig.paths.legalDocuments}${uniqueFilename}`;

      // Get content type
      const extension = filename.split('.').pop()?.toLowerCase() || '';
      const contentType = getMimeType(extension);

      // Upload to R2
      const fileMetadata = await storageClient.uploadBuffer(key, fileBuffer, {
        contentType,
        metadata: {
          ...metadata,
          userId,
          originalFilename: filename,
          uploadedAt: new Date().toISOString(),
        },
      });

      // Generate public URL
      const url = getPublicUrl(key);

      logger.info({
        type: 'document_upload_success',
        key,
        size: fileBuffer.length,
      });

      return {
        key,
        url,
        size: fileMetadata.size,
        contentType: fileMetadata.contentType,
        metadata: fileMetadata.metadata,
      };
    } catch (error: any) {
      logger.error({
        type: 'document_upload_error',
        filename,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Upload image (JPEG, PNG, WebP)
   * @param fileBuffer File buffer
   * @param filename Original filename
   * @param userId User ID
   */
  async uploadImage(
    fileBuffer: Buffer,
    filename: string,
    userId: string
  ): Promise<FileUploadResult> {
    logger.info({
      type: 'image_upload_started',
      filename,
      size: fileBuffer.length,
      userId,
    });

    try {
      // Validate file
      this.validateFile(fileBuffer, filename, 'images');

      // Generate unique filename
      const uniqueFilename = generateUniqueFilename(filename);
      const key = `${storageConfig.paths.userUploads}${userId}/${uniqueFilename}`;

      // Get content type
      const extension = filename.split('.').pop()?.toLowerCase() || '';
      const contentType = getMimeType(extension);

      // Upload to R2
      const fileMetadata = await storageClient.uploadBuffer(key, fileBuffer, {
        contentType,
        metadata: {
          userId,
          originalFilename: filename,
          uploadedAt: new Date().toISOString(),
        },
      });

      const url = getPublicUrl(key);

      logger.info({
        type: 'image_upload_success',
        key,
      });

      return {
        key,
        url,
        size: fileMetadata.size,
        contentType: fileMetadata.contentType,
      };
    } catch (error: any) {
      logger.error({
        type: 'image_upload_error',
        filename,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Upload policy export (PDF, DOCX)
   * @param fileBuffer File buffer
   * @param filename Filename
   * @param policyId Policy ID
   * @param userId User ID
   */
  async uploadPolicyExport(
    fileBuffer: Buffer,
    filename: string,
    policyId: string,
    userId: string
  ): Promise<FileUploadResult> {
    logger.info({
      type: 'policy_export_upload_started',
      filename,
      policyId,
    });

    try {
      // Validate file
      this.validateFile(fileBuffer, filename, 'exports');

      const key = `${storageConfig.paths.policyExports}${policyId}/${filename}`;

      const extension = filename.split('.').pop()?.toLowerCase() || '';
      const contentType = getMimeType(extension);

      const fileMetadata = await storageClient.uploadBuffer(key, fileBuffer, {
        contentType,
        metadata: {
          policyId,
          userId,
          exportedAt: new Date().toISOString(),
        },
      });

      const url = getPublicUrl(key);

      logger.info({
        type: 'policy_export_upload_success',
        key,
      });

      return {
        key,
        url,
        size: fileMetadata.size,
        contentType: fileMetadata.contentType,
      };
    } catch (error: any) {
      logger.error({
        type: 'policy_export_upload_error',
        filename,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Upload temporary file
   * @param fileBuffer File buffer
   * @param filename Filename
   * @param ttl Time to live in seconds
   */
  async uploadTempFile(
    fileBuffer: Buffer,
    filename: string,
    ttl: number = 3600
  ): Promise<FileUploadResult> {
    try {
      const uniqueFilename = generateUniqueFilename(filename);
      const key = `${storageConfig.paths.temp}${uniqueFilename}`;

      const extension = filename.split('.').pop()?.toLowerCase() || '';
      const contentType = getMimeType(extension);

      const fileMetadata = await storageClient.uploadBuffer(key, fileBuffer, {
        contentType,
        metadata: {
          temporary: 'true',
          expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
        },
      });

      const url = getPublicUrl(key);

      logger.info({
        type: 'temp_file_uploaded',
        key,
        ttl,
      });

      return {
        key,
        url,
        size: fileMetadata.size,
        contentType: fileMetadata.contentType,
      };
    } catch (error: any) {
      logger.error({
        type: 'temp_file_upload_error',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Download file
   * @param key File key
   * @returns File buffer
   */
  async downloadFile(key: string): Promise<Buffer> {
    try {
      return await storageClient.downloadFile(key);
    } catch (error: any) {
      logger.error({
        type: 'file_download_error',
        key,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Delete file
   * @param key File key
   */
  async deleteFile(key: string): Promise<void> {
    try {
      await storageClient.deleteFile(key);

      logger.info({
        type: 'file_deleted',
        key,
      });
    } catch (error: any) {
      logger.error({
        type: 'file_delete_error',
        key,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get presigned download URL
   * @param key File key
   * @param expiresIn Expiry in seconds
   * @param inline Whether to display inline or download
   */
  async getDownloadUrl(
    key: string,
    expiresIn?: number,
    inline: boolean = false
  ): Promise<string> {
    try {
      const metadata = await storageClient.getFileMetadata(key);

      if (!metadata) {
        throw new StorageServiceError('File not found');
      }

      const contentDisposition = inline
        ? 'inline'
        : `attachment; filename="${key.split('/').pop()}"`;

      const url = await storageClient.getPresignedDownloadUrl(key, {
        expiresIn,
        contentDisposition,
        contentType: metadata.contentType,
      });

      return url;
    } catch (error: any) {
      logger.error({
        type: 'download_url_error',
        key,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get presigned upload URL
   * @param filename Filename
   * @param contentType Content type
   * @param path Storage path
   */
  async getUploadUrl(
    filename: string,
    contentType: string,
    path: string = storageConfig.paths.userUploads
  ): Promise<{ url: string; key: string }> {
    try {
      const uniqueFilename = generateUniqueFilename(filename);
      const key = `${path}${uniqueFilename}`;

      const url = await storageClient.getPresignedUploadUrl(key, {
        contentType,
        expiresIn: storageConfig.presignedUrls.expiry.upload,
      });

      return { url, key };
    } catch (error: any) {
      logger.error({
        type: 'upload_url_error',
        filename,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get file metadata
   * @param key File key
   */
  async getFileInfo(key: string): Promise<FileMetadata | null> {
    try {
      return await storageClient.getFileMetadata(key);
    } catch (error: any) {
      logger.error({
        type: 'file_info_error',
        key,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Clean up temporary files older than specified age
   * @param maxAgeSeconds Maximum age in seconds
   */
  async cleanupTempFiles(maxAgeSeconds: number = 86400): Promise<number> {
    try {
      logger.info({
        type: 'temp_cleanup_started',
        maxAgeSeconds,
      });

      const tempFiles = await storageClient.listFiles(storageConfig.paths.temp);

      const now = Date.now();
      const oldFiles = tempFiles.filter((file: FileMetadata) => {
        if (!file.lastModified) return false;
        const age = now - file.lastModified.getTime();
        return age > maxAgeSeconds * 1000;
      });

      if (oldFiles.length > 0) {
        await Promise.all(oldFiles.map((file: FileMetadata) => this.deleteFile(file.key)));
      }

      logger.info({
        type: 'temp_cleanup_complete',
        deleted: oldFiles.length,
      });

      return oldFiles.length;
    } catch (error: any) {
      logger.error({
        type: 'temp_cleanup_error',
        error: error.message,
      });
      return 0;
    }
  }
}

/**
 * Export singleton storage service instance
 */
export const storageService = new StorageService();

/**
 * Helper functions
 */

/**
 * Upload legal document
 */
export async function uploadLegalDocument(
  fileBuffer: Buffer,
  filename: string,
  userId: string,
  metadata?: Record<string, string>
): Promise<FileUploadResult> {
  return await storageService.uploadDocument(fileBuffer, filename, userId, metadata);
}

/**
 * Upload user image
 */
export async function uploadUserImage(
  fileBuffer: Buffer,
  filename: string,
  userId: string
): Promise<FileUploadResult> {
  return await storageService.uploadImage(fileBuffer, filename, userId);
}

/**
 * Get download URL with expiry
 */
export async function getSecureDownloadUrl(
  key: string,
  expiresInHours: number = 24
): Promise<string> {
  return await storageService.getDownloadUrl(key, expiresInHours * 3600);
}
