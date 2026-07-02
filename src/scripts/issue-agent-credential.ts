import 'dotenv/config';
import {
  agentCredentialService,
  AGENT_CREDENTIAL_HEADER_DISPLAY,
  AGENT_PRINCIPALS,
  type AgentPrincipalId,
} from '@/modules/agents/agent-credential.service';
import { disconnectDatabase } from '@/lib/prisma/client';

function parsePrincipalArg(): AgentPrincipalId {
  const flagIndex = process.argv.indexOf('--principal');
  const raw = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;

  if (!raw) return 'sys-agent-orchestrator';
  if (raw in AGENT_PRINCIPALS) return raw as AgentPrincipalId;

  throw new Error(
    `Unknown --principal "${raw}". Valid values: ${Object.keys(AGENT_PRINCIPALS).join(', ')}`,
  );
}

async function main(): Promise<void> {
  const principalId = parsePrincipalArg();
  const issued = await agentCredentialService.issueNewCredential(principalId);
  const capabilities = AGENT_PRINCIPALS[principalId].capabilities;

  console.log(`Agent credential issued for principal "${principalId}". Store this secret now; it will not be shown again.`);
  console.log(`${AGENT_CREDENTIAL_HEADER_DISPLAY}: ${issued.secret}`);
  console.log(`Issued at: ${issued.issuedAt}`);
  console.log(`Version: ${issued.version}`);
  console.log(`Capabilities granted: ${capabilities.join(', ')}`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDatabase();
  });
