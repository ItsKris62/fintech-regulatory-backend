/** Read-only Batch 7.2 execution-identity migration audit. */
import 'dotenv/config';
import pg from 'pg';

const QUERY_TIMEOUT_MS = 5_000;

async function main() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: QUERY_TIMEOUT_MS });
  await client.connect();
  await client.query(`SET statement_timeout = ${QUERY_TIMEOUT_MS}`);

  const columns = await client.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'GapAnalysis'
      AND column_name IN ('documentChecksum', 'executionIdentity', 'executionIdentityMetadata')
    ORDER BY column_name
  `);
  const hasExecutionIdentity = columns.rows.some(({ column_name }) => column_name === 'executionIdentity');
  const total = await client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM "GapAnalysis"');
  const statuses = await client.query<{ status: string; count: string }>('SELECT status, COUNT(*)::text AS count FROM "GapAnalysis" GROUP BY status ORDER BY status');
  const deleted = await client.query<{ state: string; count: string }>('SELECT CASE WHEN "deletedAt" IS NULL THEN \'non_deleted\' ELSE \'deleted\' END AS state, COUNT(*)::text AS count FROM "GapAnalysis" GROUP BY 1 ORDER BY 1');
  const indexes = await client.query<{ indexname: string; indexdef: string }>(`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = 'GapAnalysis'
      AND indexname IN ('GapAnalysis_active_executionIdentity_key', 'GapAnalysis_executionIdentity_key')
    ORDER BY indexname
  `);

  const identityAudit = hasExecutionIdentity
    ? await Promise.all([
        client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM "GapAnalysis" WHERE "executionIdentity" IS NOT NULL'),
        client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM "GapAnalysis" WHERE "executionIdentity" IS NULL'),
        client.query<{ groups: string; rows: string }>('SELECT COUNT(*)::text AS groups, COALESCE(SUM(row_count), 0)::text AS rows FROM (SELECT COUNT(*) AS row_count FROM "GapAnalysis" WHERE "executionIdentity" IS NOT NULL GROUP BY "executionIdentity" HAVING COUNT(*) > 1) duplicate_groups'),
        client.query<{ groups: string; rows: string }>(`SELECT COUNT(*)::text AS groups, COALESCE(SUM(row_count), 0)::text AS rows FROM (SELECT COUNT(*) AS row_count FROM "GapAnalysis" WHERE "executionIdentity" IS NOT NULL AND "deletedAt" IS NULL AND status IN ('UPLOADING','QUEUED','RUNNING','RETRYING','ANALYZING','COMPLETING','COMPLETED') GROUP BY "executionIdentity" HAVING COUNT(*) > 1) conflicting_groups`),
        client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "GapAnalysis" WHERE "executionIdentity" IS NOT NULL AND "deletedAt" IS NULL AND status IN ('UPLOADING','QUEUED','RUNNING','RETRYING','ANALYZING','COMPLETING','COMPLETED')`),
      ])
    : null;

  console.log(JSON.stringify({
    audit: 'batch7.2-pre-migration',
    totalGapAnalysisRows: total.rows[0]?.count ?? '0',
    statusDistribution: statuses.rows,
    deletedDistribution: deleted.rows,
    executionIdentityColumns: columns.rows.map(({ column_name }) => column_name),
    executionIdentityIndexes: indexes.rows,
    executionIdentity: identityAudit ? {
      nonNullRows: identityAudit[0].rows[0]?.count ?? '0',
      legacyNullRows: identityAudit[1].rows[0]?.count ?? '0',
      duplicateGroups: identityAudit[2].rows[0],
      conflictingReservationGroups: identityAudit[3].rows[0],
      candidateReservationRows: identityAudit[4].rows[0]?.count ?? '0',
    } : 'NOT_APPLIED',
  }));
  process.exit(0);
}

main().catch((error) => {
  console.error('Batch 7.2 migration audit failed:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});
