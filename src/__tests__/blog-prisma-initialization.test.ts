import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const repoRoot = resolve(__dirname, '..', '..');

const auditedFiles = [
  'src/modules/blog-automation/source-discovery.service.ts',
  'src/modules/blog-automation/suggestion-builder.ts',
  'src/modules/blog-automation/blog-verification.service.ts',
  'src/scripts/blog-source-discovery-cron.ts',
  'src/scripts/blog-editorial-digest-cron.ts',
  'src/server/routers/blog-automation.router.ts',
];

describe('blog automation Prisma initialization safety', () => {
  it('does not create unconfigured Prisma clients in importable blog automation paths', () => {
    for (const file of auditedFiles) {
      const source = readFileSync(resolve(repoRoot, file), 'utf8');

      expect(source, file).not.toMatch(/new\s+PrismaClient\s*\(\s*\)/);
      expect(source, file).not.toMatch(/import\s+\{\s*PrismaClient\b/);
    }
  });
});