import { describe, expect, it } from 'vitest';
import {
  PHASE_27_UAT_EXPECTED_COUNTS,
  assertPhase27UatSeedSafety,
  createPhase27UatSeedSummary,
  parsePhase27UatSeedOptions,
} from './seed-blog-phase-2-7-uat';

describe('Phase 2.7 UAT blog seed safety guard', () => {
  it('allows preview runtime with Preview database classification', () => {
    expect(assertPhase27UatSeedSafety({
      APP_RUNTIME_MODE: 'preview',
      DATABASE_ENVIRONMENT: 'preview',
    })).toEqual({
      runtimeMode: 'preview',
      databaseEnvironment: 'preview',
    });
  });

  it('allows preview runtime with Development-UAT database classification', () => {
    expect(assertPhase27UatSeedSafety({
      APP_RUNTIME_MODE: 'preview',
      DATABASE_ENVIRONMENT: 'development-uat',
    })).toEqual({
      runtimeMode: 'preview',
      databaseEnvironment: 'development-uat',
    });
  });

  it('blocks when runtime mode is not preview', () => {
    expect(() => assertPhase27UatSeedSafety({
      APP_RUNTIME_MODE: 'standard',
      DATABASE_ENVIRONMENT: 'preview',
    })).toThrow(/APP_RUNTIME_MODE must be preview/);
  });

  it('blocks preview runtime with Unknown database classification', () => {
    expect(() => assertPhase27UatSeedSafety({
      APP_RUNTIME_MODE: 'preview',
      DATABASE_ENVIRONMENT: 'unknown',
    })).toThrow(/DATABASE_ENVIRONMENT must be preview or development-uat/);
  });

  it('blocks preview runtime with Production database classification', () => {
    expect(() => assertPhase27UatSeedSafety({
      APP_RUNTIME_MODE: 'preview',
      DATABASE_ENVIRONMENT: 'production',
    })).toThrow(/DATABASE_ENVIRONMENT must be preview or development-uat/);
  });

  it('keeps secret database metadata out of dry-run summaries', () => {
    const safety = assertPhase27UatSeedSafety({
      APP_RUNTIME_MODE: 'preview',
      DATABASE_ENVIRONMENT: 'preview',
      DATABASE_URL: 'secret-value-that-must-not-appear',
    });
    const summary = {
      ...createPhase27UatSeedSummary({ mode: 'seed', write: false }),
      runtimeMode: safety.runtimeMode,
      databaseEnvironment: safety.databaseEnvironment,
    };

    expect(JSON.stringify(summary)).not.toContain('secret-value-that-must-not-appear');
  });
});

describe('Phase 2.7 UAT blog seed fixture shape', () => {
  it('matches expected identity counts for operator verification', () => {
    expect(PHASE_27_UAT_EXPECTED_COUNTS).toEqual({
      blogPosts: 11,
      publishedBlogPosts: 7,
      draftBlogPosts: 1,
      archivedBlogPosts: 1,
      futureDatedPublishedBlogPosts: 1,
      softDeletedBlogPosts: 1,
      feedbackRows: 2,
      topicRequestRows: 3,
    });
  });

  it('defaults to dry-run seed mode and requires explicit write mode', () => {
    expect(parsePhase27UatSeedOptions([])).toEqual({ mode: 'seed', write: false });
    expect(parsePhase27UatSeedOptions(['--write'])).toEqual({ mode: 'seed', write: true });
    expect(parsePhase27UatSeedOptions(['--cleanup', '--write'])).toEqual({ mode: 'cleanup', write: true });
  });
});
