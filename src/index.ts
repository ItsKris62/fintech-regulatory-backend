import 'dotenv/config'; // Must be first - populates process.env before any other import reads it
import { initSentry } from './lib/sentry';
initSentry();

import * as Sentry from '@sentry/node';
import { buildApp, parseTrustProxy } from './app';
import { logger } from './utils/logger';
import { connectionManager } from './lib/connection-manager';
import { errorTracker } from './lib/error-tracker';
import { warmCaches } from './lib/cache-warming';
import { storageConfig } from './config/storage.config';
import { appConfig } from './config/app.config';
import { aiJobRunner } from './modules/ai-jobs/ai-job-runner';
import { assertPreviewDatabaseIsolation, classifyDatabaseEnvironment, isPreviewDatabaseClassificationAllowed } from './utils/database-identity';
import type { FastifyInstance } from 'fastify';

// -- Process-level error traps ------------------------------------------------
// Registered before start() so they catch failures during initialisation too.

process.on('unhandledRejection', (reason) => {
  logger.error({ type: 'unhandled_rejection', reason });
  Sentry.captureException(reason);
});

process.on('uncaughtException', (error) => {
  logger.error({
    type: 'uncaught_exception',
    error: error.message,
    stack: error.stack,
  });
  Sentry.captureException(error);
  // Give Sentry a brief moment to flush the event before exiting
  Sentry.close(2000).finally(() => {
    process.exit(1);
  });
});

// -- Graceful shutdown --------------------------------------------------------

function registerShutdownHandlers(app: FastifyInstance): void {
  const shutdown = async (signal: string) => {
    logger.info({ type: 'server_shutting_down', signal });
    try {
      errorTracker.stop();
      await aiJobRunner.stop();
      await app.close();
      await connectionManager.disconnectAll();
      logger.info({ type: 'server_shutdown_complete' });
      process.exit(0);
    } catch (error) {
      logger.error({ type: 'server_shutdown_error', error });
      Sentry.captureException(error);
      await Sentry.close(2000);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

// -- Bootstrap ----------------------------------------------------------------

// Required environment variable guard  -  fail fast before binding to network
const REQUIRED_ENV_VARS = [
  'FRONTEND_URL',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;

for (const key of REQUIRED_ENV_VARS) {
  if (!process.env[key]) {
    logger.error({ type: 'missing_required_env_var', key });
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const start = async () => {
  try {
    const backgroundWorkersDisabled = appConfig.runtime.disableBackgroundWorkers;
    assertPreviewDatabaseIsolation({
      runtimeMode: appConfig.runtime.mode,
      databaseEnvironment: appConfig.database.environment,
    });

    logger.info({
      type: 'runtime_side_effect_controls',
      runtimeMode: appConfig.runtime.mode,
      backgroundWorkers: backgroundWorkersDisabled ? 'disabled' : 'enabled',
      scheduledJobs: appConfig.runtime.disableScheduledJobs ? 'disabled' : 'api_start_does_not_register_cron',
      outboundEmail: appConfig.runtime.disableOutboundEmail ? 'disabled' : 'enabled',
      n8nAutomation: appConfig.runtime.disableN8nAutomation ? 'disabled' : 'enabled',
    });

    logger.info({
      type: 'database_identity_startup',
      applicationEnvironment: appConfig.env,
      runtimeMode: appConfig.runtime.mode,
      databaseClassification: classifyDatabaseEnvironment(appConfig.database.environment),
      previewIsolationMetadataPresent: isPreviewDatabaseClassificationAllowed(appConfig.database.environment),
    });

    // 1. Connect all external services (database is critical, Redis is degradable)
    const connectionStatus = await connectionManager.connectAll();
    logger.info({ type: 'connections_ready', status: connectionStatus });

    // 2. Warm caches (non-blocking  -  logs warnings on failure)
    await warmCaches();

    // 3. Start error tracker background cleanup
    if (backgroundWorkersDisabled) {
      logger.info({ type: 'background_workers_disabled', aiJobRunner: 'disabled', errorTrackerCleanup: 'disabled' });
    } else {
      errorTracker.start();
      aiJobRunner.start();
    }

    // 4. Build the Fastify app (registers all plugins inside an async function)
    const app = await buildApp();

    // 5. Register OS signal handlers now that we have an app reference
    registerShutdownHandlers(app);

    // 6. Bind to network
    const port = parseInt(process.env.PORT || '4000', 10);
    const host = process.env.HOST || '0.0.0.0';

    logger.warn({
      type: 'malware_scan_startup_state',
      enabled: storageConfig.security.malwareScan,
      scannerWired: Boolean(appConfig.clamav.host),
      effectivePolicy: storageConfig.security.malwareScan
        ? 'enabled_vault_uploads_scan_with_clamav'
        : 'disabled_uploads_will_skip_scanning',
    });

    await app.listen({ port, host });

    logger.info({
      type: 'server_started',
      port,
      host,
      url: `http://localhost:${port}`,
      trpcUrl: `http://localhost:${port}/trpc`,
      healthUrl: `http://localhost:${port}/health`,
      environment: process.env.NODE_ENV || 'development',
      runtimeMode: appConfig.runtime.mode,
    });

    logger.info({
      type: 'server_config',
      trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    });

    console.log(`
=============================================================

  SheriaBot API Server Started Successfully

  URL:         http://localhost:${port}
  tRPC:        http://localhost:${port}/trpc
  Health:      http://localhost:${port}/health
  Environment: ${(process.env.NODE_ENV || 'development').toUpperCase()}
  Runtime:     ${appConfig.runtime.mode.toUpperCase()}

=============================================================
    `);
  } catch (err: unknown) {
    const error = err as Error;
    logger.error({
      type: 'server_start_error',
      error: error.message,
      stack: error.stack,
    });
    Sentry.captureException(error);
    await Sentry.close(2000);
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
};

start();
