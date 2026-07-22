import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_PRINCIPALS,
  AgentCredentialError,
  AgentCredentialService,
  isAgentCapability,
  type AgentCredentialServiceDependencies,
} from './agent-credential.service';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const ORCHESTRATOR_KEY = AGENT_PRINCIPALS['sys-agent-orchestrator'].configKey;
const AUTOMATION_KEY = AGENT_PRINCIPALS['sys-automation-orchestrator'].configKey;
const SCHEDULER_KEY = AGENT_PRINCIPALS['sys-scheduler-orchestrator'].configKey;

/**
 * @param stored - map of SystemConfig key -> secret whose hash should be considered active for that key
 */
function serviceFor(args: { stored?: Record<string, string>; revoked?: number }): AgentCredentialService {
  const storedHashes: Record<string, string> = {};
  for (const [key, secret] of Object.entries(args.stored ?? {})) {
    storedHashes[key] = hash(secret);
  }

  const prisma = {
    systemConfig: {
      findUnique: vi.fn(({ where }: { where: { key: string } }) => {
        const credentialHash = storedHashes[where.key];
        if (!credentialHash) return Promise.resolve(null);
        return Promise.resolve({
          value: JSON.stringify({ credentialHash, issuedAt: new Date().toISOString(), version: 1 }),
        });
      }),
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
    const service = serviceFor({ stored: { [ORCHESTRATOR_KEY]: activeSecret } });

    await expectCredentialReason(
      service.verifyCredential('sb_agent_wrong_secret_with_enough_entropy_1234567890'),
      'invalid',
    );
  });

  it('rejects a revoked credential', async () => {
    const activeSecret = 'sb_agent_valid_secret_with_enough_entropy_1234567890';
    const service = serviceFor({ stored: { [ORCHESTRATOR_KEY]: activeSecret }, revoked: 1 });

    await expectCredentialReason(service.verifyCredential(activeSecret), 'revoked');
  });

  it('denies unlisted capabilities by default', () => {
    expect(isAgentCapability('agents.run.create')).toBe(true);
    expect(isAgentCapability('admin.updateUserRole')).toBe(false);
  });

  describe('multi-principal scoping (sys-automation-orchestrator)', () => {
    const orchestratorSecret = 'sb_agent_orchestrator_secret_with_enough_entropy_001';
    const automationSecret = 'sb_agent_automation_secret_with_enough_entropy_002';

    function bothPrincipalsService(): AgentCredentialService {
      return serviceFor({
        stored: {
          [ORCHESTRATOR_KEY]: orchestratorSecret,
          [AUTOMATION_KEY]: automationSecret,
        },
      });
    }

    it('grants the automation principal exactly its automation capabilities, nothing broader', async () => {
      const identity = await bothPrincipalsService().verifyCredential(automationSecret);

      expect(identity.userId).toBe('sys-automation-orchestrator');
      expect([...identity.capabilities].sort()).toEqual(
        [
          'agents.automation.generate',
          'agents.automation.log.create',
          'agents.automation.metrics.read',
          'agents.automation.approval.create',
          'agents.automation.approval.read',
          'agents.automation.content.publish',
          'agents.automation.content.queueCandidate',
          'agents.automation.regulatoryItems.read',
          'agents.automation.approvedContent.read',
          'agents.automation.newsletter.send',
          'agents.automation.outreach.queue',
          'agents.automation.sources.read',
          'agents.automation.sources.fetch',
          'agents.automation.sources.dedupe',
          'agents.automation.pilotCohort.read',
          'agents.automation.dpaVendor.read',
        ].sort(),
      );
    });

    it('never grants the orchestrator principal the automation capabilities', async () => {
      const identity = await bothPrincipalsService().verifyCredential(orchestratorSecret);

      expect(identity.userId).toBe('sys-agent-orchestrator');
      expect(identity.capabilities).not.toContain('agents.automation.log.create');
      expect(identity.capabilities).not.toContain('agents.automation.generate');
      expect(identity.capabilities).not.toContain('agents.automation.metrics.read');
    });

    it('does not let one principal authenticate using the other principal secret', async () => {
      const service = serviceFor({ stored: { [AUTOMATION_KEY]: automationSecret } });

      await expectCredentialReason(service.verifyCredential(orchestratorSecret), 'invalid');
    });

    it('revoking the automation credential does not affect the orchestrator credential', async () => {
      // Simulate: automation credential hash is revoked in Redis, orchestrator's is not.
      const storedHashes = { [ORCHESTRATOR_KEY]: hash(orchestratorSecret), [AUTOMATION_KEY]: hash(automationSecret) };
      const prisma = {
        systemConfig: {
          findUnique: vi.fn(({ where }: { where: { key: string } }) => {
            const credentialHash = storedHashes[where.key as keyof typeof storedHashes];
            if (!credentialHash) return Promise.resolve(null);
            return Promise.resolve({ value: JSON.stringify({ credentialHash, issuedAt: new Date().toISOString(), version: 1 }) });
          }),
          upsert: vi.fn(),
        },
        user: { upsert: vi.fn().mockResolvedValue({}) },
      };
      const redis = {
        exists: vi.fn((key: string) => Promise.resolve(key.includes(hash(automationSecret)) ? 1 : 0)),
        set: vi.fn().mockResolvedValue('OK'),
      };
      const service = new AgentCredentialService({ prisma, redis } as unknown as AgentCredentialServiceDependencies);

      await expectCredentialReason(service.verifyCredential(automationSecret), 'revoked');
      const orchestratorIdentity = await service.verifyCredential(orchestratorSecret);
      expect(orchestratorIdentity.userId).toBe('sys-agent-orchestrator');
    });
  });

  describe('multi-principal scoping (sys-scheduler-orchestrator)', () => {
    const orchestratorSecret = 'sb_agent_orchestrator_secret_with_enough_entropy_003';
    const schedulerSecret = 'sb_agent_scheduler_secret_with_enough_entropy_004';

    const TRIGGER_CAPABILITIES = [
      'agents.regIntel.run.create',
      'agents.marketing.draft.create',
      'agents.sales.draft.create',
      'agents.productBi.report.create',
      'agents.securityOps.report.create',
      'agents.chiefOfStaff.report.create',
    ];

    function bothPrincipalsService(): AgentCredentialService {
      return serviceFor({
        stored: {
          [ORCHESTRATOR_KEY]: orchestratorSecret,
          [SCHEDULER_KEY]: schedulerSecret,
        },
      });
    }

    it('grants the scheduler principal exactly the six trigger capabilities, nothing broader', async () => {
      const identity = await bothPrincipalsService().verifyCredential(schedulerSecret);

      expect(identity.userId).toBe('sys-scheduler-orchestrator');
      expect([...identity.capabilities].sort()).toEqual([...TRIGGER_CAPABILITIES].sort());
    });

    it('never grants the orchestrator principal the trigger capabilities (fully disjoint)', async () => {
      const identity = await bothPrincipalsService().verifyCredential(orchestratorSecret);

      expect(identity.userId).toBe('sys-agent-orchestrator');
      for (const capability of TRIGGER_CAPABILITIES) {
        expect(identity.capabilities).not.toContain(capability);
      }
    });

    it('does not let one principal authenticate using the other principal secret', async () => {
      const service = serviceFor({ stored: { [SCHEDULER_KEY]: schedulerSecret } });

      await expectCredentialReason(service.verifyCredential(orchestratorSecret), 'invalid');
    });

    it('revoking the scheduler credential does not affect the orchestrator credential', async () => {
      const storedHashes = { [ORCHESTRATOR_KEY]: hash(orchestratorSecret), [SCHEDULER_KEY]: hash(schedulerSecret) };
      const prisma = {
        systemConfig: {
          findUnique: vi.fn(({ where }: { where: { key: string } }) => {
            const credentialHash = storedHashes[where.key as keyof typeof storedHashes];
            if (!credentialHash) return Promise.resolve(null);
            return Promise.resolve({ value: JSON.stringify({ credentialHash, issuedAt: new Date().toISOString(), version: 1 }) });
          }),
          upsert: vi.fn(),
        },
        user: { upsert: vi.fn().mockResolvedValue({}) },
      };
      const redis = {
        exists: vi.fn((key: string) => Promise.resolve(key.includes(hash(schedulerSecret)) ? 1 : 0)),
        set: vi.fn().mockResolvedValue('OK'),
      };
      const service = new AgentCredentialService({ prisma, redis } as unknown as AgentCredentialServiceDependencies);

      await expectCredentialReason(service.verifyCredential(schedulerSecret), 'revoked');
      const orchestratorIdentity = await service.verifyCredential(orchestratorSecret);
      expect(orchestratorIdentity.userId).toBe('sys-agent-orchestrator');
    });
  });
});
