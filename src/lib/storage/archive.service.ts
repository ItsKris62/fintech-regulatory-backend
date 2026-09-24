/**
 * Archive Storage Service
 *
 * Provides server-side object archiving from primary R2 buckets (sheria-bot-saas,
 * sheria-bot-public, sheriabot-storage) to the immutable sheria-bot-backups bucket
 * using dedicated backup credentials (R2_BACKUP_ACCESS_KEY_ID / R2_BACKUP_SECRET_ACCESS_KEY).
 */

import { S3Client, CopyObjectCommand } from '@aws-sdk/client-s3';
import { appConfig } from '@/config/app.config';
import { logger } from '@/utils/logger';

export const BACKUP_BUCKET =
  appConfig.backupStorage?.bucketName ??
  process.env.R2_BACKUP_BUCKET ??
  'sheria-bot-backups';

export const backupClient = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID ?? appConfig.storage.accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_BACKUP_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.R2_BACKUP_SECRET_ACCESS_KEY ?? '',
  },
  forcePathStyle: false,
});

export interface ArchiveObjectArgs {
  sourceBucket: 'sheria-bot-saas' | 'sheria-bot-public' | 'sheriabot-storage' | string;
  sourceKey: string;
  archivePrefix: string;
}

export interface ArchiveObjectResult {
  archived: boolean;
  archiveKey: string | null;
}

let hasLoggedMissingCredentials = false;

/**
 * Copy an object from a source bucket into the sheria-bot-backups archive bucket.
 * Uses S3 CopyObjectCommand server-side copy within the Cloudflare R2 account via backupClient.
 */
export async function archiveObject(args: {
  sourceBucket: 'sheria-bot-saas' | 'sheria-bot-public' | 'sheriabot-storage' | string;
  sourceKey: string;
  archivePrefix: string;
}): Promise<ArchiveObjectResult> {
  const { sourceBucket, sourceKey, archivePrefix } = args;
  const cleanSourceKey = sourceKey.replace(/^\/+/, '');
  const destinationKey = archivePrefix.endsWith(cleanSourceKey)
    ? archivePrefix
    : `${archivePrefix.replace(/\/+$/, '')}/${sourceBucket}/${cleanSourceKey}`;

  const accessKeyId = process.env.R2_BACKUP_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_BACKUP_SECRET_ACCESS_KEY;

  if (!accessKeyId || !secretAccessKey) {
    if (!hasLoggedMissingCredentials) {
      logger.warn({
        type: 'archive_service_credentials_missing',
        message: 'R2_BACKUP_ACCESS_KEY_ID or R2_BACKUP_SECRET_ACCESS_KEY is not set.',
      });
      hasLoggedMissingCredentials = true;
    }
    return { archived: false, archiveKey: null };
  }

  try {
    const copySource = `${sourceBucket}/${cleanSourceKey.split('/').map(encodeURIComponent).join('/')}`;

    await backupClient.send(
      new CopyObjectCommand({
        Bucket: BACKUP_BUCKET,
        Key: destinationKey,
        CopySource: copySource,
      })
    );

    logger.info({
      type: 'storage_object_archived',
      sourceBucket,
      sourceKey: cleanSourceKey,
      backupBucket: BACKUP_BUCKET,
      archiveKey: destinationKey,
    });

    return { archived: true, archiveKey: destinationKey };
  } catch (error: unknown) {
    logger.error({
      type: 'storage_object_archive_failed',
      sourceBucket,
      sourceKey: cleanSourceKey,
      backupBucket: BACKUP_BUCKET,
      destinationKey,
      error: (error as Error).message,
    });
    return { archived: false, archiveKey: null };
  }
}
