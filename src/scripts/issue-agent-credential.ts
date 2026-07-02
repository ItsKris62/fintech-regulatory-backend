import 'dotenv/config';
import { agentCredentialService, AGENT_CREDENTIAL_HEADER_DISPLAY } from '@/modules/agents/agent-credential.service';
import { disconnectDatabase } from '@/lib/prisma/client';

async function main(): Promise<void> {
  const issued = await agentCredentialService.issueNewCredential();
  console.log('Agent credential issued. Store this secret now; it will not be shown again.');
  console.log(`${AGENT_CREDENTIAL_HEADER_DISPLAY}: ${issued.secret}`);
  console.log(`Issued at: ${issued.issuedAt}`);
  console.log(`Version: ${issued.version}`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDatabase();
  });