
import 'dotenv/config';
import {
  agentCredentialService,
  AGENT_CREDENTIAL_HEADER_DISPLAY,
  AGENT_PRINCIPALS,
} from './src/modules/agents/agent-credential.service';
import { disconnectDatabase } from './src/lib/prisma/client';

async function main() {
  const principalId = 'sys-scheduler-orchestrator';
  const issued = await agentCredentialService.issueNewCredential(principalId);
  const capabilities = AGENT_PRINCIPALS[principalId].capabilities;

  console.log('Agent credential issued for principal "' + principalId + '". Store this secret now; it will not be shown again.');
  console.log(AGENT_CREDENTIAL_HEADER_DISPLAY + ': ' + issued.secret);
  console.log('Issued at: ' + issued.issuedAt);
  console.log('Version: ' + issued.version);
  console.log('Capabilities granted: ' + capabilities.join(', '));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDatabase();
    process.exit(0); // Force exit to avoid hanging
  });
