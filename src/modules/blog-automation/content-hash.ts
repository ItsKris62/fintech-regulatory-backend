import { createHash } from 'crypto';

export function generateContentHash(input: {
  monitorId: string;
  normalizedUrl: string;
  title: string;
  publicationDate?: Date | null;
}): string {
  const dateStr = input.publicationDate ? input.publicationDate.toISOString() : '';
  const rawStr = `${input.monitorId}|${input.normalizedUrl}|${input.title.trim().toLowerCase()}|${dateStr}`;
  
  return createHash('sha256').update(rawStr).digest('hex');
}
