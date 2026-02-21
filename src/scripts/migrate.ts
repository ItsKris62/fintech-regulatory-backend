import 'dotenv/config';
import { execSync } from 'child_process';
import { logger } from '../utils/logger';

/**
 * Production migration script.
 * Runs `prisma migrate deploy` (not dev) for safe, non-interactive migrations.
 */

async function migrate(): Promise<void> {
  logger.info({ type: 'migration' }, 'Starting production database migration...');

  try {
    // Verify DATABASE_URL is set
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is not set');
    }

    // Run prisma migrate deploy (safe for production — applies pending migrations only)
    const output = execSync('npx prisma migrate deploy', {
      encoding: 'utf-8',
      stdio: 'pipe',
      env: process.env,
    });

    logger.info(
      { type: 'migration', output: output.trim() },
      'Database migration completed successfully'
    );
  } catch (err: unknown) {
    const error = err as Error & { stderr?: string; stdout?: string };

    logger.error(
      {
        type: 'migration',
        error: error.message,
        stderr: error.stderr?.trim(),
        stdout: error.stdout?.trim(),
      },
      'Database migration failed'
    );

    process.exit(1);
  }
}

migrate();
