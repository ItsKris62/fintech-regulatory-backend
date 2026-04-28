import { S3Client } from '@aws-sdk/client-s3';
import { appConfig } from '@/config/app.config';

export const r2PrivateClient = new S3Client({
  region: 'auto',
  endpoint: `https://${appConfig.storage.accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: appConfig.storage.accessKeyId,
    secretAccessKey: appConfig.storage.secretAccessKey,
  },
});

export const r2PrivateBucket = appConfig.storage.bucketName;
