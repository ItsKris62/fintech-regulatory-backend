import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { UserRole, UserStatus } from '@prisma/client';
import type { Redis } from '@upstash/redis';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { redis as defaultRedis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';

export const AGENT_CREDENTIAL_HEADER = 'x-agent-credential' as const;
export const AGENT_CREDENTIAL_HEADER_DISPLAY = 'X-Agent-Credential' as const;
export const AGENT_SERVICE_USER_ID = 'sys-agent-orchestrator' as const;
export const AGENT_SERVICE_EMAIL = 'sys-agent-orchestrator@sheriabot.internal' as const;

const ACTIVE_CREDENTIAL_CONFIG_KEY = 'agent.orchestrator.activeCredential' as const;
const REVOKED_CREDENTIAL_TTL_SECONDS = 365 * 24 * 60 * 60;
const CREDENTIAL_PREFIX = 'sb_agent_';

export const AGENT_CAPABILITIES = [
  'agents.run.create',
  'agents.run.read',
  'agents.run.advance',
  'agents.run.complete',
  'agents.run.fail',
  'agents.report.create',
  'agents.marketing.draft.create',
  'agents.marketing.draft.read',
  'agents.sales.draft.create',
  'agents.sales.draft.read',
] as const;

export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

const AGENT_CAPABILITY_SET: ReadonlySet<string> = new Set<string>(AGENT_CAPABILITIES);

export interface AgentIdentity {
  userId: typeof AGENT_SERVICE_USER_ID;
  email: typeof AGENT_SERVICE_EMAIL;
  role: 'SERVICE';
  capabilities: readonly AgentCapability[];
}

interface StoredAgentCredential {
  credentialHash: string;
  issuedAt: string;
  version: number;
}

export type AgentCredentialFailureReason =
  | 'missing'
  | 'malformed'
  | 'not_configured'
  | 'invalid'
  | 'revoked'
  | 'service_unavailable';

export class AgentCredentialError extends Error {
  constructor(public readonly reason: AgentCredentialFailureReason) {
    super(`Agent credential rejected: ${reason}`);
    this.name = 'AgentCredentialError';
  }
}

type AgentCredentialPrisma = Pick<typeof defaultPrisma, 'systemConfig' | 'user'>;
type AgentCredentialRedis = Pick<Redis, 'exists' | 'set'>;

export interface AgentCredentialServiceDependencies {
  prisma?: AgentCredentialPrisma;
  redis?: AgentCredentialRedis;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isHexSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function credentialRevocationKey(credentialHash: string): string {
  return `sheriabot:agents:credential:revoked:${credentialHash}`;
}

function parseStoredCredential(raw: string | null): StoredAgentCredential | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const candidate = parsed as Record<string, unknown>;
  const credentialHash = candidate.credentialHash;
  const issuedAt = candidate.issuedAt;
  const version = candidate.version;

  if (typeof credentialHash !== 'string' || !isHexSha256(credentialHash)) return null;
  if (typeof issuedAt !== 'string') return null;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return null;

  return { credentialHash, issuedAt, version };
}

function constantTimeHexEqual(leftHex: string, rightHex: string): boolean {
  if (!isHexSha256(leftHex) || !isHexSha256(rightHex)) return false;
  const left = Buffer.from(leftHex, 'hex');
  const right = Buffer.from(rightHex, 'hex');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function createSecret(): string {
  return `${CREDENTIAL_PREFIX}${randomBytes(32).toString('base64url')}`;
}

function isPlausibleCredential(value: string): boolean {
  return value.startsWith(CREDENTIAL_PREFIX) && value.length >= CREDENTIAL_PREFIX.length + 32;
}

export function isAgentCapability(value: string): value is AgentCapability {
  return AGENT_CAPABILITY_SET.has(value);
}

export class AgentCredentialService {
  private readonly prisma: AgentCredentialPrisma;
  private readonly redis: AgentCredentialRedis;

  constructor(dependencies: AgentCredentialServiceDependencies = {}) {
    this.prisma = dependencies.prisma ?? defaultPrisma;
    this.redis = dependencies.redis ?? defaultRedis;
  }

  async ensureServiceUser(): Promise<void> {
    await this.prisma.user.upsert({
      where: { id: AGENT_SERVICE_USER_ID },
      create: {
        id: AGENT_SERVICE_USER_ID,
        email: AGENT_SERVICE_EMAIL,
        fullName: 'SheriaBot Agent Orchestrator',
        role: UserRole.SERVICE,
        status: UserStatus.ACTIVE,
        accountStatus: 'active',
        emailVerified: true,
        emailVerifiedAt: new Date(),
      },
      update: {
        email: AGENT_SERVICE_EMAIL,
        fullName: 'SheriaBot Agent Orchestrator',
        role: UserRole.SERVICE,
        status: UserStatus.ACTIVE,
        accountStatus: 'active',
        emailVerified: true,
        emailVerifiedAt: new Date(),
      },
    });
  }

  async issueNewCredential(): Promise<{ secret: string; credentialHash: string; issuedAt: string; version: number }> {
    await this.ensureServiceUser();
    const previous = await this.getStoredCredential();
    if (previous) {
      await this.revokeCredentialHash(previous.credentialHash);
    }

    const secret = createSecret();
    const credentialHash = sha256Hex(secret);
    const issuedAt = new Date().toISOString();
    const version = (previous?.version ?? 0) + 1;
    const payload: StoredAgentCredential = { credentialHash, issuedAt, version };

    await this.prisma.systemConfig.upsert({
      where: { key: ACTIVE_CREDENTIAL_CONFIG_KEY },
      create: {
        key: ACTIVE_CREDENTIAL_CONFIG_KEY,
        value: JSON.stringify(payload),
        type: 'json',
        category: 'security',
        description: 'Active hashed credential for the autonomous agent service identity.',
        updatedBy: AGENT_SERVICE_USER_ID,
      },
      update: {
        value: JSON.stringify(payload),
        type: 'json',
        category: 'security',
        description: 'Active hashed credential for the autonomous agent service identity.',
        updatedBy: AGENT_SERVICE_USER_ID,
      },
    });

    logger.info({ type: 'agent_credential_issued', serviceUserId: AGENT_SERVICE_USER_ID, version });
    return { secret, credentialHash, issuedAt, version };
  }

  async revokeActiveCredential(): Promise<void> {
    const active = await this.getStoredCredential();
    if (!active) return;
    await this.revokeCredentialHash(active.credentialHash);
  }

  async verifyCredential(secret: string | null): Promise<AgentIdentity> {
    if (!secret) throw new AgentCredentialError('missing');
    if (!isPlausibleCredential(secret)) throw new AgentCredentialError('malformed');

    const active = await this.getStoredCredential();
    if (!active) throw new AgentCredentialError('not_configured');

    const presentedHash = sha256Hex(secret);
    if (!constantTimeHexEqual(active.credentialHash, presentedHash)) {
      throw new AgentCredentialError('invalid');
    }

    let revoked: number;
    try {
      revoked = await this.redis.exists(credentialRevocationKey(presentedHash));
    } catch (error: unknown) {
      logger.error({ type: 'agent_credential_revocation_check_failed', error: error instanceof Error ? error.message : String(error) });
      throw new AgentCredentialError('service_unavailable');
    }

    if (revoked === 1) throw new AgentCredentialError('revoked');

    await this.ensureServiceUser();
    return {
      userId: AGENT_SERVICE_USER_ID,
      email: AGENT_SERVICE_EMAIL,
      role: 'SERVICE',
      capabilities: AGENT_CAPABILITIES,
    };
  }

  private async getStoredCredential(): Promise<StoredAgentCredential | null> {
    const row = await this.prisma.systemConfig.findUnique({
      where: { key: ACTIVE_CREDENTIAL_CONFIG_KEY },
      select: { value: true },
    });
    return parseStoredCredential(row?.value ?? null);
  }

  private async revokeCredentialHash(credentialHash: string): Promise<void> {
    await this.redis.set(credentialRevocationKey(credentialHash), 'rotated', { ex: REVOKED_CREDENTIAL_TTL_SECONDS });
    logger.info({ type: 'agent_credential_revoked', serviceUserId: AGENT_SERVICE_USER_ID });
  }
}

export const agentCredentialService = new AgentCredentialService();