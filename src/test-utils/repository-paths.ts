import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const backendRoot = resolve(process.env.SHERIABOT_BACKEND_ROOT ?? process.cwd());
export const frontendRoot = resolve(
  process.env.SHERIABOT_FRONTEND_ROOT ?? resolve(backendRoot, '..', 'fintech-regulatory-platform'),
);
export const workspaceRoot = resolve(
  process.env.SHERIABOT_WORKSPACE_ROOT ?? resolve(backendRoot, '..'),
);

export function readBackendFile(relativePath: string): string {
  return readFileSync(resolve(backendRoot, relativePath), 'utf8');
}

export function readFrontendFile(relativePath: string): string {
  return readFileSync(resolve(frontendRoot, relativePath), 'utf8');
}

export function readWorkspaceFile(relativePath: string): string {
  if (relativePath.startsWith('fintech-regulatory-backend/')) {
    return readBackendFile(relativePath.slice('fintech-regulatory-backend/'.length));
  }
  if (relativePath.startsWith('fintech-regulatory-platform/')) {
    return readFrontendFile(relativePath.slice('fintech-regulatory-platform/'.length));
  }
  return readFileSync(resolve(workspaceRoot, relativePath), 'utf8');
}
