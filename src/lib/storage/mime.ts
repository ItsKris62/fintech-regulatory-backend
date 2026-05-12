// Vault uploads intentionally exclude executable or browser-executable formats:
// text/html, image/svg+xml, application/x-msdownload, archives, and scripts.
export const VAULT_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'text/plain',
  'text/csv',
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

export const ALLOWED_VAULT_MIME_TYPES = new Set<string>(VAULT_MIME_TYPES);

export type VaultMimeType = (typeof VAULT_MIME_TYPES)[number];

export const MIME_TO_EXTENSION: Record<VaultMimeType, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
