import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod';

import { appConfig } from '@/config/app.config';
import { logger } from '@/utils/logger';
import { StorageServiceError } from '@/utils/error';

/* -------------------------------------------------------------------------- */
/*                                  Constants                                 */
/* -------------------------------------------------------------------------- */

const AVATAR_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AvatarContentType = (typeof AVATAR_CONTENT_TYPES)[number];

const CONTENT_TYPE_TO_EXT: Record<AvatarContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Presigned PUT URL expiry: 5 minutes */
const AVATAR_UPLOAD_EXPIRY_SECONDS = 300;

/** Max avatar file size: 5 MB */
export const AVATAR_MAX_FILE_SIZE = 5 * 1024 * 1024;

/* -------------------------------------------------------------------------- */
/*                             Validation Schema                              */
/* -------------------------------------------------------------------------- */

export const avatarUploadSchema = z.object({
  contentType: z.enum(AVATAR_CONTENT_TYPES),
  fileSize: z
    .number()
    .int()
    .positive()
    .max(AVATAR_MAX_FILE_SIZE, `File size must not exceed ${AVATAR_MAX_FILE_SIZE / 1024 / 1024} MB`),
});

export type AvatarUploadInput = z.infer<typeof avatarUploadSchema>;

/* -------------------------------------------------------------------------- */
/*                              S3 Client Factory                             */
/* -------------------------------------------------------------------------- */

/**
 * Returns a new S3Client configured for the R2 public bucket.
 * A new instance is created per call — lightweight since R2 is stateless HTTP.
 */
function getPublicR2Client(): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: appConfig.publicStorage.endpoint,
    credentials: {
      accessKeyId: appConfig.publicStorage.accessKeyId,
      secretAccessKey: appConfig.publicStorage.secretAccessKey,
    },
    forcePathStyle: false,
  });
}

/* -------------------------------------------------------------------------- */
/*                               Key / URL Helpers                            */
/* -------------------------------------------------------------------------- */

/**
 * Derives the R2 object key for a user's avatar.
 * Pattern: `avatars/{userId}/avatar.{ext}`
 */
function buildAvatarKey(userId: string, contentType: AvatarContentType): string {
  const ext = CONTENT_TYPE_TO_EXT[contentType];
  return `avatars/${userId}/avatar.${ext}`;
}

/**
 * Derives the R2 object key from an existing public avatar URL.
 * Returns null if the URL does not belong to the configured public bucket.
 */
export function extractKeyFromAvatarUrl(avatarUrl: string): string | null {
  const prefix = appConfig.publicStorage.bucketUrl;
  if (!avatarUrl.startsWith(prefix)) return null;
  // Strip leading slash after the bucket URL
  return avatarUrl.slice(prefix.length).replace(/^\//, '');
}

/* -------------------------------------------------------------------------- */
/*                             Public API                                     */
/* -------------------------------------------------------------------------- */

/**
 * Generates a presigned PUT URL so the browser can upload an avatar
 * directly to R2 without routing through the backend.
 *
 * @returns uploadUrl  — PUT directly to this URL with the file body
 * @returns publicUrl  — Permanent public URL once the upload completes
 * @returns key        — R2 object key (store alongside publicUrl if needed)
 */
export async function generateAvatarUploadUrl(
  userId: string,
  contentType: AvatarContentType
): Promise<{ uploadUrl: string; publicUrl: string; key: string }> {
  const client = getPublicR2Client();
  const key = buildAvatarKey(userId, contentType);

  const cmd = new PutObjectCommand({
    Bucket: appConfig.publicStorage.bucketName,
    Key: key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(client, cmd, {
    expiresIn: AVATAR_UPLOAD_EXPIRY_SECONDS,
  });

  const publicUrl = `${appConfig.publicStorage.bucketUrl}/${key}`;

  logger.info({ type: 'avatar_presigned_url_generated', userId, key });

  return { uploadUrl, publicUrl, key };
}

/**
 * Deletes an avatar object from R2 using its object key.
 * The key is derived from the stored avatar URL via `extractKeyFromAvatarUrl`.
 * Throws `StorageServiceError` on failure.
 */
export async function deleteAvatarByKey(key: string): Promise<void> {
  const client = getPublicR2Client();

  const cmd = new DeleteObjectCommand({
    Bucket: appConfig.publicStorage.bucketName,
    Key: key,
  });

  try {
    await client.send(cmd);
    logger.info({ type: 'avatar_deleted', key });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error({ type: 'avatar_delete_error', key, error: message });
    throw new StorageServiceError(`Avatar delete failed: ${message}`);
  }
}
