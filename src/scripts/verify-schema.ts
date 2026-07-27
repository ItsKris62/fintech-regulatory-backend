import 'dotenv/config';
import { prisma } from '../lib/prisma/client';
import { verifyDatabaseSchema } from '../utils/schema-verifier';
import { logger } from '../utils/logger';

async function runSchemaVerificationCLI(): Promise<void> {
  console.log('=== SheriaBot Read-Only Schema Verification ===\n');

  const databaseUrl = process.env.DATABASE_URL || '';
  const runner = {
    async queryRaw<T = unknown>(query: string, ...params: unknown[]): Promise<T[]> {
      return (prisma as any).$queryRawUnsafe(query, ...params);
    },
  };

  const result = await verifyDatabaseSchema(runner, databaseUrl);

  console.log(`Target Environment : ${result.targetEnvironment}`);
  console.log(`Gate Status        : ${result.gateStatus}`);
  console.log(`Verification Result: ${result.success ? 'PASSED' : 'FAILED'}\n`);

  if (result.matchedTables.length > 0) {
    console.log(`Matched Tables (${result.matchedTables.length}):`, result.matchedTables.join(', '));
  }

  if (result.details.length > 0) {
    console.log('\nVerification Details:');
    result.details.forEach((d) => console.log(` - ${d}`));
  }

  if (!result.success) {
    logger.error({ type: 'schema_verifier_cli_failure', result }, 'Schema verification failed or was blocked by safety gate.');
    if (result.gateStatus === 'BLOCKED_NO_STAGING_URL' || result.gateStatus === 'BLOCKED_PRODUCTION_TARGET') {
      console.log('\n[GATE BLOCKED] Staging credentials missing or production target protected. Halting pre-migration step.');
    }
    process.exit(1);
  } else {
    console.log('\n[GATE PASSED] Database schema matches Phase 0 baseline expectations cleanly.');
    process.exit(0);
  }
}

if (require.main === module) {
  runSchemaVerificationCLI().catch((err) => {
    console.error('Fatal Schema Verification Error:', err);
    process.exit(1);
  });
}
