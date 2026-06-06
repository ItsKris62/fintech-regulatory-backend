/**
 * Copies backend declaration files into the publishable @sheriabot/api-types package.
 *
 * Usage:
 *   pnpm run api-types:prepare
 */

import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';

const backendRoot = process.cwd();
const distRoot = join(backendRoot, 'dist');
const apiTypesDistRoot = join(backendRoot, 'api-types', 'dist');

async function copyDeclarations(sourceDir: string): Promise<number> {
  let copied = 0;
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);

    if (entry.isDirectory()) {
      copied += await copyDeclarations(sourcePath);
      continue;
    }

    if (!entry.isFile() || extname(entry.name) !== '.ts' || !entry.name.endsWith('.d.ts')) {
      continue;
    }

    const targetPath = join(apiTypesDistRoot, relative(distRoot, sourcePath));
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    copied++;
  }

  return copied;
}

async function main(): Promise<void> {
  await rm(apiTypesDistRoot, { recursive: true, force: true });
  const copied = await copyDeclarations(distRoot);
  console.log(`Prepared @sheriabot/api-types with ${copied} declaration files.`);
}

main().catch((error) => {
  console.error('prepare-api-types-package failed:', error);
  process.exit(1);
});
