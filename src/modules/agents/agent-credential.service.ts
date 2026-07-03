import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { UserRole, UserStatus } from '@prisma/client';
import type { Redis } from '@upstash/redis';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { redis as defaultRedis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';

export const AGENT_CREDENTIAL_HEADER = 'x-agent-credential' as const;
export const AGENT_CREDENTIAL_HEADER_DISPLAY = 'X-Agent-Credential' as const;
// Retained for backward compatibility with callers importing the legacy
// single-principal constants directly.
export const AGENT_SERVICE_USER_ID = 'sys-agent-orchestrator' as const;
export const AGENT_SERVICE_EMAIL = 'sys-agent-orchestrator@sheriabot.internal' as const;

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
  'agents.automation.log.create',
  'agents.automation.generate',
  'agents.productBi.report.create',
  'agents.productBi.report.read',
  'agents.securityOps.report.create',
  'agents.securityOps.report.read',
  'agents.chiefOfStaff.report.create',
  'agents.chiefOfStaff.report.read',
] as const;

export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

const AGENT_CAPABILITY_SET: ReadonlySet<string> = new Set<string>(AGENT_CAPABILITIES);

// Capabilities granted to the n8n automation surface only. Deliberately
// excluded from the general orchestrator principal below so a leaked
// automation secret can never call the broader agent-run/marketing/sales API.
const AUTOMATION_CAPABILITIES: readonly AgentCapability[] = [
  'agents.automation.log.create',
  'agents.automation.generate',
];

export type AgentPrincipalId = 'sys-agent-orchestrator' | 'sys-automation-orchestrator';

interface AgentPrincipalDefinition {
  principalId: AgentPrincipalId;
  email: string;
  fullName: string;
  configKey: string;
  capabilities: readonly AgentCapability[];
}

/**
 * Distinct service principals, each with its own hashed secret (stored
 * under its own SystemConfig key) and its own fixed capability grant.
 * verifyCredential() matches a presented secret against every principal
 * and returns only the matched principal's own capabilities  -  capabilities
 * are never unioned across principals, and issuing/revoking one principal's
 * credential never touches another's.
 */
export const AGENT_PRINCIPALS: Record<AgentPrincipalId, AgentPrincipalDefinition> = {
  'sys-agent-orchestrator': {
    principalId: 'sys-agent-orchestrator',
    email: AGENT_SERVICE_EMAIL,
    fullName: 'SheriaBot Agent Orchestrator',
    configKey: 'agent.orchestrator.activeCredential',
    capabilities: AGENT_CAPABILITIES.filter((c) => !AUTOMATION_CAPABILITIES.includes(c)),
  },
  'sys-automation-orchestrator': {
    principalId: 'sys-automation-orchestrator',
    email: 'sys-automation-orchestrator@sheriabot.internal',
    fullName: 'SheriaBot Automation Orchestrator (n8n)',
    configKey: 'agent.automationOrchestrator.activeCredential',
    capabilities: AUTOMATION_CAPABILITIES,
  },
};

export interface AgentIdentity {
  userId: AgentPrincipalId;
  email: string;
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

  async ensureServiceUser(principalId: AgentPrincipalId = 'sys-agent-orchestrator'): Promise<void> {
    const principal = AGENT_PRINCIPALS[principalId];
    await this.prisma.user.upsert({
      where: { id: principal.principalId },
      create: {
        id: principal.principalId,
        email: principal.email,
        fullName: principal.fullName,
        role: UserRole.SERVICE,
        status: UserStatus.ACTIVE,
        accountStatus: 'active',
        emailVerified: true,
        emailVerifiedAt: new Date(),
      },
      update: {
        email: principal.email,
        fullName: principal.fullName,
        role: UserRole.SERVICE,
        status: UserStatus.ACTIVE,
        accountStatus: 'active',
        emailVerified: true,
        emailVerifiedAt: new Date(),
      },
    });
  }

  async issueNewCredential(
    principalId: AgentPrincipalId = 'sys-agent-orchestrator',
  ): Promise<{ secret: string; credentialHash: string; issuedAt: string; version: number }> {
    const principal = AGENT_PRINCIPALS[principalId];
    await this.ensureServiceUser(principalId);
    const previous = await this.getStoredCredential(principal.configKey);
    if (previous) {
      await this.revokeCredentialHash(previous.credentialHash, principalId);
    }

    const secret = createSecret();
    const credentialHash = sha256Hex(secret);
    const issuedAt = new Date().toISOString();
    const version = (previous?.version ?? 0) + 1;
    const payload: StoredAgentCredential = { credentialHash, issuedAt, version };

    await this.prisma.systemConfig.upsert({
      where: { key: principal.configKey },
      create: {
        key: principal.configKey,
        value: JSON.stringify(payload),
        type: 'json',
        category: 'security',
        description: `Active hashed credential for the ${principal.principalId} service identity.`,
        updatedBy: principal.principalId,
      },
      update: {
        value: JSON.stringify(payload),
        type: 'json',
        category: 'security',
        description: `Active hashed credential for the ${principal.principalId} service identity.`,
        updatedBy: principal.principalId,
      },
    });

    logger.info({ type: 'agent_credential_issued', serviceUserId: principal.principalId, version });
    return { secret, credentialHash, issuedAt, version };
  }

  async revokeActiveCredential(principalId: AgentPrincipalId = 'sys-agent-orchestrator'): Promise<void> {
    const principal = AGENT_PRINCIPALS[principalId];
    const active = await this.getStoredCredential(principal.configKey);
    if (!active) return;
    await this.revokeCredentialHash(active.credentialHash, principalId);
  }

  async verifyCredential(secret: string | null): Promise<AgentIdentity> {
    if (!secret) throw new AgentCredentialError('missing');
    if (!isPlausibleCredential(secret)) throw new AgentCredentialError('malformed');

    const presentedHash = sha256Hex(secret);
    const principals = Object.values(AGENT_PRINCIPALS);
    const stored = await Promise.all(
      principals.map((principal) => this.getStoredCredential(principal.configKey)),
    );

    if (stored.every((candidate) => candidate === null)) {
      throw new AgentCredentialError('not_configured');
    }

    // Evaluate every principal (no early exit) so a mismatch on principal A
    // doesn't take a measurably different code path than a match  -  presenting
    // an invalid secret and presenting a secret for the "wrong" principal
    // should be indistinguishable from timing alone.
    let matched: AgentPrincipalDefinition | null = null;
    for (let i = 0; i < principals.length; i++) {
      const candidate = stored[i];
      if (candidate && constantTimeHexEqual(candidate.credentialHash, presentedHash)) {
        matched = principals[i];
      }
    }

    if (!matched) throw new AgentCredentialError('invalid');

    let revoked: number;
    try {
      revoked = await this.redis.exists(credentialRevocationKey(presentedHash));
    } catch (error: unknown) {
      logger.error({ type: 'agent_credential_revocation_check_failed', error: error instanceof Error ? error.message : String(error) });
      throw new AgentCredentialError('service_unavailable');
    }

    if (revoked === 1) throw new AgentCredentialError('revoked');

    await this.ensureServiceUser(matched.principalId);
    return {
      userId: matched.principalId,
      email: matched.email,
      role: 'SERVICE',
      capabilities: matched.capabilities,
    };
  }

  private async getStoredCredential(configKey: string): Promise<StoredAgentCredential | null> {
    const row = await this.prisma.systemConfig.findUnique({
      where: { key: configKey },
      select: { value: true },
    });
    return parseStoredCredential(row?.value ?? null);
  }

  private async revokeCredentialHash(credentialHash: string, principalId: AgentPrincipalId): Promise<void> {
    await this.redis.set(credentialRevocationKey(credentialHash), 'rotated', { ex: REVOKED_CREDENTIAL_TTL_SECONDS });
    logger.info({ type: 'agent_credential_revoked', serviceUserId: principalId });
  }
}

export const agentCredentialService = new AgentCredentialService();
