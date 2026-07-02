import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentCredentialError,
  AgentCredentialService,
  isAgentCapability,
  type AgentCredentialServiceDependencies,
} from './agent-credential.service';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function serviceFor(args: { storedHash?: string; revoked?: number }): AgentCredentialService {
  const prisma = {
    systemConfig: {
      findUnique: vi.fn().mockResolvedValue(args.storedHash
        ? { value: JSON.stringify({ credentialHash: args.storedHash, issuedAt: new Date().toISOString(), version: 1 }) }
        : null),
      upsert: vi.fn(),
    },
    user: {
      upsert: vi.fn().mockResolvedValue({}),
    },
  };
  const redis = {
    exists: vi.fn().mockResolvedValue(args.revoked ?? 0),
    set: vi.fn().mockResolvedValue('OK'),
  };
  return new AgentCredentialService({ prisma, redis } as unknown as AgentCredentialServiceDependencies);
}

async function expectCredentialReason(promise: Promise<unknown>, reason: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ reason });
  await expect(promise).rejects.toBeInstanceOf(AgentCredentialError);
}

describe('AgentCredentialService', () => {
  it('rejects a missing credential', async () => {
    await expectCredentialReason(serviceFor({}).verifyCredential(null), 'missing');
  });

  it('rejects an invalid credential', async () => {
    const activeSecret = 'sb_agent_valid_secret_with_enough_entropy_1234567890';
    const service = serviceFor({ storedHash: hash(activeSecret) });

    await expectCredentialReason(
      service.verifyCredential('sb_agent_wrong_secret_with_enough_entropy_1234567890'),
      'invalid',
    );
  });

  it('rejects a revoked credential', async () => {
    const activeSecret = 'sb_agent_valid_secret_with_enough_entropy_1234567890';
    const service = serviceFor({ storedHash: hash(activeSecret), revoked: 1 });

    await expectCredentialReason(service.verifyCredential(activeSecret), 'revoked');
  });

  it('denies unlisted capabilities by default', () => {
    expect(isAgentCapability('agents.run.create')).toBe(true);
    expect(isAgentCapability('admin.updateUserRole')).toBe(false);
  });
});