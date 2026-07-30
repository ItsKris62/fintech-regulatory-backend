export type AppRuntimeMode = 'standard' | 'preview';
export type DatabaseEnvironment = 'unknown' | 'preview' | 'development-uat' | 'production';
export type SafeDatabaseClassification = 'Unknown' | 'Preview' | 'Development-UAT' | 'Production';

export interface PreviewDatabaseGuardInput {
  runtimeMode: AppRuntimeMode;
  databaseEnvironment: DatabaseEnvironment;
}

export interface DatabaseUatRecordCounts {
  blogPosts: number;
  publishedBlogPosts: number;
  draftBlogPosts: number;
  archivedBlogPosts: number;
  futureDatedPublishedBlogPosts: number;
  softDeletedBlogPosts: number;
  feedbackRows: number;
  topicRequestRows: number;
}

export interface SafeDatabaseIdentityReport {
  applicationEnvironment: string;
  runtimeMode: AppRuntimeMode;
  databaseClassification: SafeDatabaseClassification;
  databaseName: string | null;
  migrationCount: number | null;
  uatRecordMarker: string;
  uatRecordCounts: DatabaseUatRecordCounts | null;
  previewIsolationMetadataPresent: boolean;
}

export interface DatabaseIdentityQueryRunner {
  getDatabaseName(): Promise<string>;
  getMigrationCount(): Promise<number>;
  getUatRecordCounts(marker: string): Promise<DatabaseUatRecordCounts>;
}

export const DEFAULT_UAT_RECORD_MARKER = 'phase-2-7-uat';

export function classifyDatabaseEnvironment(
  databaseEnvironment: DatabaseEnvironment,
): SafeDatabaseClassification {
  switch (databaseEnvironment) {
    case 'preview':
      return 'Preview';
    case 'development-uat':
      return 'Development-UAT';
    case 'production':
      return 'Production';
    case 'unknown':
      return 'Unknown';
  }
}

export function isPreviewDatabaseClassificationAllowed(
  databaseEnvironment: DatabaseEnvironment,
): boolean {
  return databaseEnvironment === 'preview' || databaseEnvironment === 'development-uat';
}

export function assertPreviewDatabaseIsolation(input: PreviewDatabaseGuardInput): void {
  if (input.runtimeMode !== 'preview') return;
  if (isPreviewDatabaseClassificationAllowed(input.databaseEnvironment)) return;

  const classification = classifyDatabaseEnvironment(input.databaseEnvironment);
  throw new Error(
    `Preview startup blocked: DATABASE_ENVIRONMENT must be preview or development-uat. Current classification is ${classification}.`,
  );
}

export function createUnqueriedDatabaseIdentityReport(args: {
  applicationEnvironment: string;
  runtimeMode: AppRuntimeMode;
  databaseEnvironment: DatabaseEnvironment;
  marker?: string;
}): SafeDatabaseIdentityReport {
  const marker = args.marker ?? DEFAULT_UAT_RECORD_MARKER;
  return {
    applicationEnvironment: args.applicationEnvironment,
    runtimeMode: args.runtimeMode,
    databaseClassification: classifyDatabaseEnvironment(args.databaseEnvironment),
    databaseName: null,
    migrationCount: null,
    uatRecordMarker: marker,
    uatRecordCounts: null,
    previewIsolationMetadataPresent: isPreviewDatabaseClassificationAllowed(args.databaseEnvironment),
  };
}

export async function collectSafeDatabaseIdentityReport(args: {
  applicationEnvironment: string;
  runtimeMode: AppRuntimeMode;
  databaseEnvironment: DatabaseEnvironment;
  queryRunner: DatabaseIdentityQueryRunner;
  marker?: string;
}): Promise<SafeDatabaseIdentityReport> {
  assertPreviewDatabaseIsolation({
    runtimeMode: args.runtimeMode,
    databaseEnvironment: args.databaseEnvironment,
  });

  if (!isPreviewDatabaseClassificationAllowed(args.databaseEnvironment)) {
    return createUnqueriedDatabaseIdentityReport(args);
  }

  const marker = args.marker ?? DEFAULT_UAT_RECORD_MARKER;
  const [databaseName, migrationCount, uatRecordCounts] = await Promise.all([
    args.queryRunner.getDatabaseName(),
    args.queryRunner.getMigrationCount(),
    args.queryRunner.getUatRecordCounts(marker),
  ]);

  return {
    applicationEnvironment: args.applicationEnvironment,
    runtimeMode: args.runtimeMode,
    databaseClassification: classifyDatabaseEnvironment(args.databaseEnvironment),
    databaseName,
    migrationCount,
    uatRecordMarker: marker,
    uatRecordCounts,
    previewIsolationMetadataPresent: true,
  };
}
