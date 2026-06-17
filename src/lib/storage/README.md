# File Storage (Cloudflare R2)

This directory contains the file storage service for SheriaBot using Cloudflare R2 (S3-compatible object storage).

## 📁 Structure

```
storage/
├── client.ts           # R2 client (S3-compatible operations)
├── storage.service.ts  # High-level storage service with validation
└── README.md           # This file
```

## 🚀 Getting Started

### 1. Set Up Cloudflare R2

Create an R2 bucket at [dash.cloudflare.com](https://dash.cloudflare.com):

1. Go to R2 in your Cloudflare dashboard
2. Create a new bucket (e.g., `sheriabot-files`)
3. Create API tokens with read/write access
4. Note your Account ID

### 2. Environment Setup

Add to `.env`:

```bash
# Cloudflare R2
R2_ACCOUNT_ID=your-account-id
R2_ACCESS_KEY_ID=your-access-key
R2_SECRET_ACCESS_KEY=your-secret-key
R2_BUCKET_NAME=sheriabot-files
R2_PUBLIC_URL=https://your-bucket.r2.dev  # Optional custom domain
```

### 3. Install Dependencies

```bash
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

### 4. Test Storage

## 📚 Usage Examples

### Upload Document

```typescript
import { storageService } from '@/lib/storage/storage.service';

const result = await storageService.uploadDocument(
  fileBuffer,
  'Data_Protection_Act_2019.pdf',
  'user-123',
  {
    documentType: 'legal_act',
    year: '2019',
    regulatoryArea: 'Data Protection',
  }
);

console.log({
  key: result.key,
  url: result.url,
  size: result.size,
});
```

### Upload Image

```typescript
const result = await storageService.uploadImage(
  imageBuffer,
  'profile-photo.jpg',
  'user-123'
);

console.log('Image URL:', result.url);
```

### Download File

```typescript
const buffer = await storageService.downloadFile('legal-documents/doc.pdf');

// Save to disk
fs.writeFileSync('downloaded.pdf', buffer);
```

### Get Secure Download URL

```typescript
// URL expires in 24 hours
const url = await storageService.getDownloadUrl(
  'legal-documents/doc.pdf',
  24 * 3600
);

// Send URL to user
res.json({ downloadUrl: url });
```

### Get Upload URL (Direct Upload)

```typescript
// For frontend to upload directly to R2
const { url, key } = await storageService.getUploadUrl(
  'user-document.pdf',
  'application/pdf',
  'user-uploads/'
);

// Send to frontend
res.json({ uploadUrl: url, fileKey: key });
```

### Delete File

```typescript
await storageService.deleteFile('legal-documents/old-doc.pdf');
```

### Upload Policy Export

```typescript
const result = await storageService.uploadPolicyExport(
  policyPdfBuffer,
  'Digital_Lending_Policy.pdf',
  'policy-123',
  'user-456'
);
```

### Upload Temporary File

```typescript
// Auto-expires after 1 hour
const result = await storageService.uploadTempFile(
  fileBuffer,
  'temp-report.pdf',
  3600  // TTL in seconds
);
```

## 🔧 Low-Level Client Operations

### Basic Upload/Download

```typescript
import { uploadFile, downloadFile, deleteFile } from '@/lib/storage/client';

// Upload
await uploadFile('path/to/file.pdf', buffer, {
  contentType: 'application/pdf',
  metadata: {
    userId: '123',
    uploadedAt: new Date().toISOString(),
  },
});

// Download
const buffer = await downloadFile('path/to/file.pdf');

// Delete
await deleteFile('path/to/file.pdf');
```

### Check File Exists

```typescript
import { fileExists } from '@/lib/storage/client';

const exists = await fileExists('legal-documents/doc.pdf');
console.log('File exists:', exists);
```

### Get File Metadata

```typescript
import { getFileMetadata } from '@/lib/storage/client';

const metadata = await getFileMetadata('legal-documents/doc.pdf');

if (metadata) {
  console.log({
    size: metadata.size,
    contentType: metadata.contentType,
    lastModified: metadata.lastModified,
  });
}
```

### List Files

```typescript
import { listFiles } from '@/lib/storage/client';

const files = await listFiles('legal-documents/', 100);

files.forEach(file => {
  console.log(`${file.key}: ${file.size} bytes`);
});
```

### Copy/Move Files

```typescript
import { copyFile, moveFile } from '@/lib/storage/client';

// Copy
await copyFile(
  'legal-documents/original.pdf',
  'legal-documents/backup.pdf'
);

// Move
await moveFile(
  'temp/file.pdf',
  'permanent/file.pdf'
);
```

### Batch Delete

```typescript
import { deleteFiles } from '@/lib/storage/client';

await deleteFiles([
  'temp/file1.pdf',
  'temp/file2.pdf',
  'temp/file3.pdf',
]);
```

## 📊 Storage Organization

Files are organized by path prefix:

```
bucket-root/
├── legal-documents/          # Legal acts, regulations
│   ├── Data_Protection_Act_2019.pdf
│   └── Digital_Credit_Regs_2022.pdf
├── policy-exports/           # Generated policies
│   └── policy-123/
│       └── Digital_Lending_Framework.pdf
├── user-uploads/             # User-uploaded files
│   └── user-123/
│       └── document.pdf
└── temp/                     # Temporary files (auto-cleanup)
    └── temp-file-xyz.pdf
```

## 🔒 File Validation

The storage service automatically validates:

### File Type Restrictions

**Documents:**
- ✅ PDF (`.pdf`)
- ✅ Word (`.docx`)
- ✅ Text (`.txt`)

**Images:**
- ✅ JPEG (`.jpg`, `.jpeg`)
- ✅ PNG (`.png`)
- ✅ WebP (`.webp`)

**Exports:**
- ✅ PDF (`.pdf`)
- ✅ Word (`.docx`)
- ✅ Excel (`.xlsx`)

### File Size Limits

- Documents: 10 MB
- Images: 5 MB
- Exports: 50 MB

Configured in `src/config/storage.config.ts`.

### Security Checks

- ✅ Path traversal prevention
- ✅ File type validation
- ✅ Size limit enforcement
- ✅ Malware scanning (placeholder - implement as needed)

## 🔐 Presigned URLs

Presigned URLs provide temporary, secure access to files.

### Download URL

```typescript
// Expires in 1 hour
const url = await storageService.getDownloadUrl(
  'legal-documents/doc.pdf',
  3600,  // seconds
  false  // download (not inline)
);

// Expires in 24 hours, display inline
const url = await storageService.getDownloadUrl(
  'policy-exports/policy.pdf',
  24 * 3600,
  true  // inline (for preview)
);
```

### Upload URL

```typescript
// Frontend can upload directly to R2
const { url, key } = await storageService.getUploadUrl(
  'user-document.pdf',
  'application/pdf'
);

// Frontend usage:
// fetch(url, {
//   method: 'PUT',
//   body: fileBlob,
//   headers: { 'Content-Type': 'application/pdf' }
// });
```

### Expiry Times (Defaults)

- Download: 1 hour
- Upload: 5 minutes
- Viewing: 24 hours
- Sharing: 7 days

## 🧹 Cleanup & Maintenance

### Cleanup Temporary Files

```typescript
// Delete temp files older than 24 hours
const deleted = await storageService.cleanupTempFiles(86400);
console.log(`Deleted ${deleted} temp files`);
```

Set up a cron job:

```typescript
// Run daily at 2 AM
import { storageService } from '@/lib/storage/storage.service';

setInterval(async () => {
  await storageService.cleanupTempFiles(86400);
}, 24 * 60 * 60 * 1000);
```

### Get Storage Statistics

```typescript
import { getStorageStats } from '@/lib/storage/client';

const stats = await getStorageStats();

console.log({
  totalFiles: stats.totalFiles,
  totalSize: stats.totalSize,
  filesByPath: stats.filesByPath,
});
```

## 🚀 Advanced Features

### Custom Metadata

Attach metadata to files:

```typescript
await uploadFile('doc.pdf', buffer, {
  contentType: 'application/pdf',
  metadata: {
    userId: '123',
    documentType: 'legal_act',
    year: '2019',
    regulatoryArea: 'Data Protection',
    indexed: 'true',
  },
});
```

### Content Disposition

Control how files are displayed:

```typescript
// Force download
const url = await getPresignedDownloadUrl('doc.pdf', {
  contentDisposition: 'attachment; filename="My_Document.pdf"',
});

// Display inline (preview)
const url = await getPresignedDownloadUrl('doc.pdf', {
  contentDisposition: 'inline',
});
```

### Public URLs

For public files (if bucket is configured for public access):

```typescript
import { getPublicUrl } from '@/config/storage.config';

const url = getPublicUrl('legal-documents/public-doc.pdf');
// Returns: https://your-bucket.r2.dev/legal-documents/public-doc.pdf
```

## 📈 Performance

### Upload Performance

- Small files (<1MB): ~200-500ms
- Medium files (1-10MB): ~1-3s
- Large files (10-50MB): ~5-15s

### Download Performance

- Small files: ~100-300ms
- Medium files: ~500ms-2s
- Large files: ~2-10s

### Optimization Tips

1. **Use presigned URLs** for direct uploads from frontend
2. **Compress files** before upload (especially images)
3. **Use CDN** for frequently accessed files
4. **Batch operations** when possible
5. **Cache metadata** in Redis to avoid R2 calls

## 🐛 Troubleshooting

### Issue: Upload Fails

**Check:**
1. File size within limits
2. File type is allowed
3. R2 credentials are correct
4. Bucket name is correct

```typescript
// Test connection
import { fileExists } from '@/lib/storage/client';

try {
  await fileExists('test-file.txt');
  console.log('R2 connection working');
} catch (error) {
  console.error('R2 connection failed:', error);
}
```

### Issue: Files Not Accessible

**Solutions:**
- Check bucket public access settings
- Verify presigned URL hasn't expired
- Ensure correct file key/path

### Issue: Slow Performance

**Solutions:**
- Use presigned URLs for direct uploads
- Enable Cloudflare CDN
- Compress files before upload
- Use R2 in region closest to users

## 🔧 Configuration

All storage configuration is in `src/config/storage.config.ts`:

```typescript
export const storageConfig = {
  r2: {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucketName: process.env.R2_BUCKET_NAME,
    publicUrl: process.env.R2_PUBLIC_URL,
  },
  limits: {
    maxDocumentSize: 10 * 1024 * 1024,    // 10 MB
    maxImageSize: 5 * 1024 * 1024,        // 5 MB
    maxExportSize: 50 * 1024 * 1024,      // 50 MB
  },
  paths: {
    legalDocuments: 'legal-documents/',
    policyExports: 'policy-exports/',
    userUploads: 'user-uploads/',
    temp: 'temp/',
  },
};
```

## 🚦 Best Practices

1. **Always validate files** before upload
2. **Use presigned URLs** for user uploads
3. **Set appropriate expiry times** for URLs
4. **Clean up temp files** regularly
5. **Use metadata** for organization
6. **Monitor storage usage** and costs
7. **Implement malware scanning** for production
8. **Use CDN** for public files
9. **Compress large files** before upload
10. **Set lifecycle rules** in R2 for auto-cleanup

## 💰 Cost Optimization

Cloudflare R2 Pricing:
- Storage: $0.015 per GB/month
- Class A operations (writes): $4.50 per million
- Class B operations (reads): $0.36 per million
- **No egress fees!** (major advantage)

Tips to reduce costs:
1. Delete unused files regularly
2. Use temp file cleanup
3. Cache presigned URLs
4. Batch operations when possible
5. Compress files before upload

## 📚 Additional Resources

- [Cloudflare R2 Documentation](https://developers.cloudflare.com/r2/)
- [S3 SDK for JavaScript](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/clients/client-s3/)
- [Presigned URLs Guide](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [R2 Pricing](https://developers.cloudflare.com/r2/pricing/)