import { describe, expect, it } from 'vitest';
import {
  assertPreviewDatabaseIsolation,
  collectSafeDatabaseIdentityReport,
  createUnqueriedDatabaseIdentityReport,
  type DatabaseIdentityQueryRunner,
} from './database-identity';

const fakeRunner: DatabaseIdentityQueryRunner = {
  async getDatabaseName() {
    return 'sheriabot_preview';
  },
  async getMigrationCount() {
    return 33;
  },
  async getUatRecordCounts() {
    return {
      blogPosts: 14,
      publishedBlogPosts: 6,
      draftBlogPosts: 1,
      archivedBlogPosts: 1,
      futureDatedPublishedBlogPosts: 1,
      softDeletedBlogPosts: 1,
      feedbackRows: 2,
      topicRequestRows: 3,
    };
  },
};

describe('preview database isolation guard', () => {
  it('allows preview runtime with Preview classification', () => {
    expect(() => assertPreviewDatabaseIsolation({
      runtimeMode: 'preview',
      databaseEnvironment: 'preview',
    })).not.toThrow();
  });

  it('allows preview runtime with Development-UAT classification', () => {
    expect(() => assertPreviewDatabaseIsolation({
      runtimeMode: 'preview',
      databaseEnvironment: 'development-uat',
    })).not.toThrow();
  });

  it('fails preview runtime with Unknown classification', () => {
    expect(() => assertPreviewDatabaseIsolation({
      runtimeMode: 'preview',
      databaseEnvironment: 'unknown',
    })).toThrow(/Preview startup blocked/);
  });

  it('fails preview runtime with Production classification', () => {
    expect(() => assertPreviewDatabaseIsolation({
      runtimeMode: 'preview',
      databaseEnvironment: 'production',
    })).toThrow(/Current classification is Production/);
  });

  it('leaves standard production runtime behavior unchanged', () => {
    expect(() => assertPreviewDatabaseIsolation({
      runtimeMode: 'standard',
      databaseEnvironment: 'production',
    })).not.toThrow();
    expect(() => assertPreviewDatabaseIsolation({
      runtimeMode: 'standard',
      databaseEnvironment: 'unknown',
    })).not.toThrow();
  });
});

describe('safe database identity report', () => {
  it('collects only safe preview identity fields when classification permits querying', async () => {
    const report = await collectSafeDatabaseIdentityReport({
      applicationEnvironment: 'production',
      runtimeMode: 'preview',
      databaseEnvironment: 'preview',
      queryRunner: fakeRunner,
    });

    expect(report).toMatchObject({
      applicationEnvironment: 'production',
      runtimeMode: 'preview',
      databaseClassification: 'Preview',
      databaseName: 'sheriabot_preview',
      migrationCount: 33,
      previewIsolationMetadataPresent: true,
    });
    expect(report.uatRecordCounts?.blogPosts).toBe(14);
  });

  it('does not include secret database metadata in report output', async () => {
    const report = await collectSafeDatabaseIdentityReport({
      applicationEnvironment: 'production',
      runtimeMode: 'preview',
      databaseEnvironment: 'preview',
      queryRunner: fakeRunner,
    });

    const serialized = JSON.stringify({
      ...report,
      ignoredInputThatMustNotLeak: undefined,
    });

    expect(serialized).not.toContain('postgresql://');
    expect(serialized).not.toContain('preview-db.example.test');
    expect(serialized).not.toContain('db-user');
    expect(serialized).not.toContain('super-secret-password');
  });

  it('does not query or expose database name for unclassified databases', () => {
    const report = createUnqueriedDatabaseIdentityReport({
      applicationEnvironment: 'development',
      runtimeMode: 'standard',
      databaseEnvironment: 'unknown',
    });

    expect(report).toMatchObject({
      databaseClassification: 'Unknown',
      databaseName: null,
      migrationCount: null,
      uatRecordCounts: null,
      previewIsolationMetadataPresent: false,
    });
  });
});
