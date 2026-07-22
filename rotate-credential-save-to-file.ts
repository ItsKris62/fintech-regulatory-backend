
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { join } from 'path';
import {
  agentCredentialService,
  AGENT_PRINCIPALS,
} from './src/modules/agents/agent-credential.service';
import { disconnectDatabase } from './src/lib/prisma/client';

async function main() {
  const principalId = 'sys-scheduler-orchestrator';
  const issued = await agentCredentialService.issueNewCredential(principalId);
  const outputPath = join(__dirname, 'sys-scheduler-orchestrator-credential.txt');
  writeFileSync(outputPath, issued.secret, 'utf8');
  console.log(`Credential rotated! Saved to: ${outputPath}`);
  console.log(`Version: ${issued.version}`);
  console.log(`DO NOT PASTE THIS FILE'S CONTENT INTO ANY CHAT!`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDatabase();
    process.exit(0);
  });
