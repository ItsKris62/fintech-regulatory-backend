import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAutomationIncidentRoutes } from './automation-incident.route';
import { agentCredentialService } from '@/modules/agents/agent-credential.service';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';

vi.setConfig({ testTimeout: 20000 });

// Mock dependencies
vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    $transaction: vi.fn(async (cb) => {
      // Mock the transaction object
      const tx = {
        automationIncident: {
          findUnique: vi.fn(),
          create: vi.fn(),
          update: vi.fn(),
          upsert: vi.fn().mockResolvedValue({ id: 'inc_123' }),
        },
        automationIncidentOccurrence: {
          create: vi.fn(),
        },
      };
      return cb(tx);
    }),
    automationIncidentOccurrence: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    user: {
      findUnique: vi.fn(),
    }
  }
}));

vi.mock('@/lib/redis/client', () => ({
  redis: {
    set: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
  }
}));

vi.mock('@/modules/agents/agent-credential.service', () => ({
  agentCredentialService: {
    verifyCredential: vi.fn(),
  },
  AGENT_CREDENTIAL_HEADER: 'x-agent-credential',
}));

// Mock Supabase
vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    auth: {
      getUser: vi.fn(),
    }
  }
}));

function buildApp(): FastifyInstance {
  const app = Fastify();
  app.register(registerAutomationIncidentRoutes);
  return app;
}

const VALID_PAYLOAD = {
  fingerprint: 'f'.repeat(64),
  environment: 'test',
  workflowKey: 'W-TEST-01',
  category: 'NetworkTimeout',
  severity: 'HIGH',
  retryable: true,
  requiresHumanAction: false,
  sideEffectState: 'NONE',
  safeMessage: 'Test message',
};

describe('POST /internal/automation/v1/incidents', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.clearAllMocks();
  });

  it('rejects without credential', async () => {
    app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/internal/automation/v1/incidents',
      payload: VALID_PAYLOAD,
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects with invalid capability', async () => {
    app = buildApp();
    vi.mocked(agentCredentialService.verifyCredential).mockResolvedValue({
      userId: 'sys-automation-orchestrator',
      email: 'test@example.com',
      role: 'SERVICE',
      capabilities: ['some.other.capability'] as any,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/automation/v1/incidents',
      headers: { 'x-agent-credential': 'valid-secret' },
      payload: VALID_PAYLOAD,
    });

    expect(response.statusCode).toBe(403);
  });

  it('accepts valid incident and correctly creates new DB entry if not found', async () => {
    app = buildApp();
    
    vi.mocked(agentCredentialService.verifyCredential).mockResolvedValue({
      userId: 'sys-automation-orchestrator',
      email: 'sys-automation-orchestrator@sheriabot.internal',
      role: 'SERVICE',
      capabilities: ['agents.automation.incident.create'] as any,
    });

    vi.mocked(redis.set).mockResolvedValue('OK'); // Cooldown acquired

    // Mock transaction behavior
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        automationIncident: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 'inc_123' }),
          update: vi.fn().mockResolvedValue({ id: 'inc_123', occurrenceCount: 1 }),
          upsert: vi.fn().mockResolvedValue({ id: 'inc_123', occurrenceCount: 0, severity: 'HIGH', status: 'OPEN' }),
        },
        automationIncidentOccurrence: {
          create: vi.fn().mockResolvedValue({ id: 'occ_1' }),
        },
      };
      return cb(tx); // the route logic returns `incident` which has `.id`
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/automation/v1/incidents',
      headers: { 
        'x-agent-credential': 'valid-secret',
        'idempotency-key': '0'.repeat(64)
      },
      payload: VALID_PAYLOAD,
    });

    if (response.statusCode !== 200) {
      console.log("TEST FAILURE BODY:", response.json());
    }
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ persisted: true, incidentId: 'inc_123', isNewIncident: true, notify: true, occurrenceId: 'occ_1' });
  });

  it('suppresses alert if cooldown is active for existing incident', async () => {
    app = buildApp();
    
    vi.mocked(agentCredentialService.verifyCredential).mockResolvedValue({
      userId: 'sys-automation-orchestrator',
      email: 'sys-automation-orchestrator@sheriabot.internal',
      role: 'SERVICE',
      capabilities: ['agents.automation.incident.create'] as any,
    });

    // Redis indicates cooldown is active (recently notified)
    vi.mocked(redis.get).mockResolvedValue(JSON.stringify({
      lastNotifiedAt: new Date().toISOString(),
      lastNotifiedSeverity: 'HIGH',
      lastNotifiedOccurrenceCount: 1,
      status: 'OPEN'
    }));
    vi.mocked(redis.set).mockResolvedValue('OK');

    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        automationIncident: {
          findUnique: vi.fn().mockResolvedValue({ 
            id: 'inc_123', 
            status: 'OPEN',
            lastSeenAt: new Date(Date.now() - 1000) // Seen 1s ago
          }),
          create: vi.fn(),
          update: vi.fn().mockResolvedValue({ id: 'inc_123' }),
          upsert: vi.fn().mockResolvedValue({ id: 'inc_123', occurrenceCount: 2, severity: 'HIGH', status: 'OPEN' }),
        },
        automationIncidentOccurrence: {
          create: vi.fn().mockResolvedValue({ id: 'occ_2' }),
        },
      };
      return cb(tx);
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/automation/v1/incidents',
      headers: { 
        'x-agent-credential': 'valid-secret',
        'idempotency-key': '1'.repeat(64)
      },
      payload: VALID_PAYLOAD,
    });

    if (response.statusCode !== 200) {
      console.log("TEST FAILURE BODY:", response.json());
    }
    expect(response.statusCode).toBe(200);
    // Alert should be false due to cooldown
    expect(response.json()).toMatchObject({ persisted: true, incidentId: 'inc_123', isNewIncident: false, notify: false, occurrenceId: 'occ_2' });
  });
});
