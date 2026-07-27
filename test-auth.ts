import 'dotenv/config';
import Fastify from 'fastify';
import { registerAutomationIncidentRoutes } from './src/routes/automation-incident.route';
import { agentCredentialService } from './src/modules/agents/agent-credential.service';
import { prisma } from './src/lib/prisma/client';

async function runAuthTest() {
  console.log('[Test] Starting lightweight Fastify...');
  const app = Fastify();
  await app.register(registerAutomationIncidentRoutes);
  await app.ready();
  console.log('[Test] App ready. Issuing new automation credential...');
  
  try {
    const { secret } = await agentCredentialService.issueNewCredential('sys-automation-orchestrator');
    console.log('[Test] Credential issued. Testing unauthenticated request...');

    const res1 = await app.inject({
      method: 'POST',
      url: '/internal/automation/v1/incidents',
      payload: {
        fingerprint: 'auth-test',
        environment: 'local',
        workflowKey: 'W-TEST',
        category: 'Test',
        severity: 'INFO',
        retryable: false,
        requiresHumanAction: false,
        sideEffectState: 'NONE',
        safeMessage: 'Auth test'
      }
    });

    console.log(`[Test] Unauthenticated response status: ${res1.statusCode}`);
    if (res1.statusCode !== 401) {
      throw new Error(`Expected 401, got ${res1.statusCode}`);
    }

    console.log('[Test] Testing authenticated request...');
    const res2 = await app.inject({
      method: 'POST',
      url: '/internal/automation/v1/incidents',
      headers: {
        'x-agent-credential': secret
      },
      payload: {
        fingerprint: 'auth-test',
        environment: 'local',
        workflowKey: 'W-TEST',
        category: 'Test',
        severity: 'INFO',
        retryable: false,
        requiresHumanAction: false,
        sideEffectState: 'NONE',
        safeMessage: 'Auth test'
      }
    });

    console.log(`[Test] Authenticated response status: ${res2.statusCode}`);
    if (res2.statusCode !== 200) {
      throw new Error(`Expected 200, got ${res2.statusCode}: ${res2.body}`);
    }

    console.log('[Test] Auth middleware verified successfully! Automation credentials are working perfectly.');
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  } finally {
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  }
}

runAuthTest().catch(console.error);
