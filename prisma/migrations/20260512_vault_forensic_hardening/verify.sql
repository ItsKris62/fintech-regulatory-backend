-- Run BEFORE applying migration.sql (paste results in handoff)
-- Expected: no rows returned from any query
SELECT column_name FROM information_schema.columns
WHERE table_name = 'VaultDocument'
  AND column_name IN ('r2Bucket','contentHash','encryptionKeyId',
                      'uploadStatus','retentionExpiresAt','deletedAt');

SELECT typname FROM pg_type
WHERE typname = 'VaultDocumentUploadStatus';

-- Run AFTER applying migration.sql (paste results in handoff)
-- Expected: 6 rows for columns, 1 row for enum, 4 rows for indexes
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'VaultDocument'
  AND column_name IN ('r2Bucket','contentHash','encryptionKeyId',
                      'uploadStatus','retentionExpiresAt','deletedAt')
ORDER BY column_name;

SELECT enumlabel FROM pg_enum
WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'VaultDocumentUploadStatus')
ORDER BY enumsortorder;

SELECT indexname FROM pg_indexes
WHERE tablename = 'VaultDocument'
  AND indexname IN (
    'VaultDocument_uploadStatus_idx',
    'VaultDocument_deletedAt_idx',
    'VaultDocument_retentionExpiresAt_idx',
    'VaultDocument_organizationId_deletedAt_idx'
  )
ORDER BY indexname;
