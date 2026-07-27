import 'dotenv/config';
import { prisma } from '../lib/prisma/client';
import { Prisma } from '@prisma/client';
import {
  verifyCompleteSchema,
  VerifierMode,
  EnvironmentIdentity,
  QueryRunner,
} from '../utils/schema-verifier';
import { logger } from '../utils/logger';

async function runSchemaVerificationCLI(): Promise<void> {
  const args = process.argv.slice(2);
  let mode: VerifierMode = 'post';
  let isJson = false;

  for (const arg of args) {
    if (arg === '--mode=pre') {
      mode = 'pre';
    } else if (arg === '--mode=post') {
      mode = 'post';
    } else if (arg === '--json') {
      isJson = true;
    }
  }

  const identity: EnvironmentIdentity = {
    appEnv: process.env.APP_ENV || process.env.NODE_ENV,
    databaseEnv: process.env.DATABASE_ENVIRONMENT,
    databaseUrl: process.env.DATABASE_URL,
  };

  const runner: QueryRunner = {
    async queryRaw<T = unknown>(query: string): Promise<T[]> {
      return prisma.$queryRaw(Prisma.raw(query)) as Promise<T[]>;
    },
  };

  const result = await verifyCompleteSchema(mode, identity, runner);

  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('=== SheriaBot Content & Marketing Schema Verifier ===');
    console.log(`Mode               : ${result.mode.toUpperCase()}`);
    console.log(`App Environment    : ${result.environment.appEnv}`);
    console.log(`DB Environment     : ${result.environment.databaseEnv}`);
    console.log(`Target URL         : ${result.environment.redactedUrl}`);
    console.log(`Gate Status        : ${result.gateStatus}`);
    console.log(`Overall Result     : ${result.success ? 'PASSED' : 'FAILED'}\n`);

    console.log('Summary Counts:');
    console.log(` - Total Checked    : ${result.summaryCounts.totalChecked}`);
    console.log(` - Present          : ${result.summaryCounts.present}`);
    console.log(` - Missing Expected : ${result.summaryCounts.missingExpected}`);
    console.log(` - Missing Unexpect : ${result.summaryCounts.missingUnexpected}`);
    console.log(` - Conflict         : ${result.summaryCounts.conflict}`);
    console.log(` - Advisory Warnings: ${result.summaryCounts.warn}\n`);

    if (result.results.length > 0) {
      console.log('Sample Object Verification Breakdown:');
      result.results.slice(0, 20).forEach((item) => {
        console.log(` [${item.status}] ${item.category} ${item.objectName}: ${item.reason}`);
      });
      if (result.results.length > 20) {
        console.log(` ... and ${result.results.length - 20} more items.`);
      }
    }
  }

  if (!result.success) {
    if (!isJson) {
      logger.error({ type: 'schema_verifier_cli_failure', gateStatus: result.gateStatus }, 'Schema verification CLI failed.');
    }
    process.exit(1);
  } else {
    process.exit(0);
  }
}

if (require.main === module) {
  runSchemaVerificationCLI().catch((err) => {
    console.error('Fatal Schema Verification Error:', err);
    process.exit(1);
  });
}
