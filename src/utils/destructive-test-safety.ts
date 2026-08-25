/**
 * Destructive Test Database Safety Guard
 *
 * Ensures that destructive integration tests (purging users, scrubbing queries,
 * deleting vault documents) NEVER run against production databases, production
 * connection strings, or cloud replicas.
 */

export function isSafeTestDatabaseUrl(databaseUrl?: string): { safe: boolean; reason?: string } {
  const url = databaseUrl || process.env.DATABASE_URL || '';
  if (!url) {
    return { safe: false, reason: 'DATABASE_URL is empty or undefined' };
  }

  const lowercase = url.toLowerCase();

  // Hard blocked production indicators
  const productionIndicators = [
    'supabase.co',
    'pooler.supabase.com',
    'aws.com',
    'rds.amazonaws.com',
    'render.com',
    'production',
  ];

  for (const indicator of productionIndicators) {
    // If it points to an external cloud database or has 'production'
    if (lowercase.includes(indicator)) {
      // If it's explicitly an external production host
      return {
        safe: false,
        reason: `Connection string contains production indicator '${indicator}'. Destructive tests must only target local/disposable test databases.`,
      };
    }
  }

  // Safe if host is localhost / 127.0.0.1 / test container / sqlite / in-memory
  const isLocalOrTest =
    lowercase.includes('localhost') ||
    lowercase.includes('127.0.0.1') ||
    lowercase.includes('test') ||
    lowercase.includes('disposable') ||
    lowercase.startsWith('file:') ||
    lowercase.startsWith('sqlite:');

  if (!isLocalOrTest) {
    return {
      safe: false,
      reason: 'Database host is not recognized as a local/disposable test instance.',
    };
  }

  return { safe: true };
}

export function assertSafeTestDatabase(databaseUrl?: string): void {
  const check = isSafeTestDatabaseUrl(databaseUrl);
  if (!check.safe) {
    throw new Error(`DESTRUCTIVE TEST SAFETY VIOLATION: ${check.reason}`);
  }
}
