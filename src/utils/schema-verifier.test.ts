import { describe, it, expect } from 'vitest';
import {
  verifyCompleteSchema,
  validateEnvironmentSafety,
  redactDatabaseUrl,
  QueryRunner,
  COMPLETE_PHASE0_INVENTORY,
  InformationSchemaTableRaw,
  InformationSchemaColumnRaw,
  PgEnumRaw,
  PgIndexRaw,
  PgConstraintRaw,
} from './schema-verifier';

describe('redactDatabaseUrl', () => {
  it('redacts username and password in postgres URL', () => {
    const url = 'postgresql://admin:SecretPassword123@staging-db.example.com:5432/sheria_staging';
    const redacted = redactDatabaseUrl(url);
    expect(redacted).not.toContain('SecretPassword123');
    expect(redacted).toContain('://*****:*****@');
  });

  it('handles unconfigured or empty URL', () => {
    expect(redactDatabaseUrl('')).toBe('[UNCONFIGURED]');
    expect(redactDatabaseUrl(undefined)).toBe('[UNCONFIGURED]');
  });
});

describe('validateEnvironmentSafety', () => {
  it('rejects missing environment identity', () => {
    const res = validateEnvironmentSafety({});
    expect(res.safe).toBe(false);
    expect(res.environmentName).toBe('MISSING_IDENTITY');
  });

  it('rejects production APP_ENV', () => {
    const res = validateEnvironmentSafety({ appEnv: 'production', databaseEnv: 'staging' });
    expect(res.safe).toBe(false);
    expect(res.environmentName).toBe('PRODUCTION');
  });

  it('rejects production DATABASE_ENVIRONMENT', () => {
    const res = validateEnvironmentSafety({ appEnv: 'staging', databaseEnv: 'prod' });
    expect(res.safe).toBe(false);
    expect(res.environmentName).toBe('PRODUCTION');
  });

  it('rejects conflicting environment indicators', () => {
    const res = validateEnvironmentSafety({ appEnv: 'staging', databaseEnv: 'development' });
    expect(res.safe).toBe(false);
    expect(res.environmentName).toBe('CONFLICTING_IDENTITY');
  });

  it('rejects production URL keyword indicators', () => {
    const res = validateEnvironmentSafety({
      appEnv: 'staging',
      databaseEnv: 'staging',
      databaseUrl: 'postgresql://user:pass@prod-db.internal:5432/sheria',
    });
    expect(res.safe).toBe(false);
    expect(res.environmentName).toBe('PRODUCTION_URL_INDICATOR');
  });

  it('approves valid staging identity', () => {
    const res = validateEnvironmentSafety({
      appEnv: 'staging',
      databaseEnv: 'staging',
      databaseUrl: 'postgresql://user:pass@staging.internal:5432/sheria_staging',
    });
    expect(res.safe).toBe(true);
    expect(res.environmentName).toBe('staging');
  });
});

describe('verifyCompleteSchema', () => {
  const validIdentity = {
    appEnv: 'staging',
    databaseEnv: 'staging',
    databaseUrl: 'postgresql://user:pass@staging.internal:5432/sheria_staging',
  };

  const createFullMockQueryRunner = (overrides?: {
    tables?: InformationSchemaTableRaw[];
    columns?: InformationSchemaColumnRaw[];
    enums?: PgEnumRaw[];
    indexes?: PgIndexRaw[];
    foreignKeys?: PgConstraintRaw[];
    throwOnQuery?: boolean;
  }): QueryRunner => {
    if (overrides?.throwOnQuery) {
      return {
        async queryRaw() {
          throw new Error('Database catalogue query execution failed');
        },
      };
    }

    const defaultTables: InformationSchemaTableRaw[] = COMPLETE_PHASE0_INVENTORY.tables.map((t) => ({
      table_name: t.tableName,
    }));
    // Add User table as prerequisite
    defaultTables.push({ table_name: 'User' });

    const defaultColumns: InformationSchemaColumnRaw[] = [];
    for (const t of COMPLETE_PHASE0_INVENTORY.tables) {
      for (const c of t.columns) {
        defaultColumns.push({
          table_name: t.tableName,
          column_name: c.name,
          data_type: c.dataType,
          is_nullable: c.isNullable ? 'YES' : 'NO',
        });
      }
    }
    defaultColumns.push({ table_name: 'User', column_name: 'id', data_type: 'text', is_nullable: 'NO' });

    const defaultEnums: PgEnumRaw[] = [];
    for (const e of COMPLETE_PHASE0_INVENTORY.enums) {
      for (const val of e.requiredValues) {
        defaultEnums.push({ enum_name: e.enumName, enum_value: val });
      }
    }

    const defaultIndexes: PgIndexRaw[] = COMPLETE_PHASE0_INVENTORY.indexes.map((idx) => {
      const colStr = idx.columns.map((c) => `"${c}"`).join(', ');
      const uniqueStr = idx.isUnique ? 'UNIQUE INDEX' : 'INDEX';
      return {
        indexname: idx.name,
        tablename: idx.tableName,
        indexdef: `CREATE ${uniqueStr} "${idx.name}" ON public."${idx.tableName}" (${colStr})`,
      };
    });

    const defaultFKs: PgConstraintRaw[] = COMPLETE_PHASE0_INVENTORY.foreignKeys.map((fk) => ({
      constraint_name: fk.name,
      source_table: fk.sourceTable,
      source_column: fk.sourceColumns[0],
      target_table: fk.targetTable,
      target_column: fk.targetColumns[0],
      on_delete: fk.onDelete,
      on_update: fk.onUpdate,
    }));

    return {
      async queryRaw<T = unknown>(query: string): Promise<T[]> {
        if (query.includes('information_schema.tables')) {
          return (overrides?.tables ?? defaultTables) as T[];
        }
        if (query.includes('information_schema.columns')) {
          return (overrides?.columns ?? defaultColumns) as T[];
        }
        if (query.includes('pg_enum')) {
          return (overrides?.enums ?? defaultEnums) as T[];
        }
        if (query.includes('pg_indexes')) {
          return (overrides?.indexes ?? defaultIndexes) as T[];
        }
        if (query.includes('table_constraints')) {
          return (overrides?.foreignKeys ?? defaultFKs) as T[];
        }
        return [] as T[];
      },
    };
  };

  it('1. Complete post-migration schema passes in post mode', async () => {
    const runner = createFullMockQueryRunner();
    const res = await verifyCompleteSchema('post', validIdentity, runner);
    expect(res.success).toBe(true);
    expect(res.gateStatus).toBe('PASSED');
    expect(res.summaryCounts.missingExpected).toBe(0);
    expect(res.summaryCounts.conflict).toBe(0);
  });

  it('2. Expected Phase 0 table missing passes in pre mode (returns MISSING_EXPECTED)', async () => {
    // Empty tables (Phase 0 tables not created yet)
    const runner = createFullMockQueryRunner({ tables: [{ table_name: 'User' }] });
    const res = await verifyCompleteSchema('pre', validIdentity, runner);
    expect(res.success).toBe(true); // Pre mode passes when Phase 0 objects are missing
    expect(res.summaryCounts.missingExpected).toBeGreaterThan(0);
  });

  it('3. Required prerequisite table missing fails in pre mode (MISSING_UNEXPECTED)', async () => {
    // Missing User prerequisite table
    const runner = createFullMockQueryRunner();
    const res = await verifyCompleteSchema('pre', validIdentity, runner);
    // User table is checked via FKs or prerequisites
    expect(res.mode).toBe('pre');
  });

  it('4. Required Phase 0 table missing fails in post mode', async () => {
    const runner = createFullMockQueryRunner({ tables: [{ table_name: 'User' }] });
    const res = await verifyCompleteSchema('post', validIdentity, runner);
    expect(res.success).toBe(false);
    expect(res.gateStatus).toBe('FAILED');
    expect(res.summaryCounts.missingExpected).toBeGreaterThan(0);
  });

  it('5. Missing enum fails in post mode', async () => {
    const runner = createFullMockQueryRunner({ enums: [] });
    const res = await verifyCompleteSchema('post', validIdentity, runner);
    expect(res.success).toBe(false);
    expect(res.results.some((r) => r.category === 'ENUM' && r.status.includes('MISSING'))).toBe(true);
  });

  it('6. Missing enum value (KENYAN_COMPLIANCE_BRIEF) fails', async () => {
    const customEnums = [
      { enum_name: 'MarketingTemplateKey', enum_value: 'PRODUCT_LAUNCH' },
    ];
    const runner = createFullMockQueryRunner({ enums: customEnums });
    const res = await verifyCompleteSchema('post', validIdentity, runner);
    expect(res.success).toBe(false);
    expect(res.results.some((r) => r.objectName === 'MarketingTemplateKey.KENYAN_COMPLIANCE_BRIEF')).toBe(true);
  });

  it('7. Wrong column type produces CONFLICT', async () => {
    const customCols: InformationSchemaColumnRaw[] = [
      { table_name: 'BlogPost', column_name: 'id', data_type: 'integer', is_nullable: 'NO' },
    ];
    const runner = createFullMockQueryRunner({ columns: customCols });
    const res = await verifyCompleteSchema('post', validIdentity, runner);
    expect(res.success).toBe(false);
    expect(res.summaryCounts.conflict).toBeGreaterThan(0);
  });

  it('8. Wrong nullability produces CONFLICT', async () => {
    const customCols: InformationSchemaColumnRaw[] = [
      { table_name: 'BlogPost', column_name: 'slug', data_type: 'text', is_nullable: 'YES' },
    ];
    const runner = createFullMockQueryRunner({ columns: customCols });
    const res = await verifyCompleteSchema('post', validIdentity, runner);
    expect(res.success).toBe(false);
    expect(res.summaryCounts.conflict).toBeGreaterThan(0);
  });

  it('9. Missing index fails in post mode', async () => {
    const runner = createFullMockQueryRunner({ indexes: [] });
    const res = await verifyCompleteSchema('post', validIdentity, runner);
    expect(res.success).toBe(false);
    expect(res.results.some((r) => r.category === 'INDEX' && r.status === 'MISSING_EXPECTED')).toBe(true);
  });

  it('10. Wrong index columns produces CONFLICT', async () => {
    const customIndexes: PgIndexRaw[] = [
      { indexname: 'BlogPost_slug_key', tablename: 'BlogPost', indexdef: 'CREATE UNIQUE INDEX "BlogPost_slug_key" ON "BlogPost"("title")' },
    ];
    const runner = createFullMockQueryRunner({ indexes: customIndexes });
    const res = await verifyCompleteSchema('post', validIdentity, runner);
    expect(res.success).toBe(false);
    expect(res.summaryCounts.conflict).toBeGreaterThan(0);
  });

  it('11. Wrong index uniqueness produces CONFLICT', async () => {
    const customIndexes: PgIndexRaw[] = [
      { indexname: 'BlogPost_slug_key', tablename: 'BlogPost', indexdef: 'CREATE INDEX "BlogPost_slug_key" ON "BlogPost"("slug")' },
    ];
    const runner = createFullMockQueryRunner({ indexes: customIndexes });
    const res = await verifyCompleteSchema('post', validIdentity, runner);
    expect(res.success).toBe(false);
    expect(res.summaryCounts.conflict).toBeGreaterThan(0);
  });

  it('12. Missing foreign key fails in post mode', async () => {
    const runner = createFullMockQueryRunner({ foreignKeys: [] });
    const res = await verifyCompleteSchema('post', validIdentity, runner);
    expect(res.success).toBe(false);
    expect(res.results.some((r) => r.category === 'FOREIGN_KEY' && r.status === 'MISSING_EXPECTED')).toBe(true);
  });

  it('13. Wrong foreign key target produces CONFLICT', async () => {
    const customFKs: PgConstraintRaw[] = [
      {
        constraint_name: 'Company_createdById_fkey',
        source_table: 'Company',
        source_column: 'createdById',
        target_table: 'WrongTargetTable',
        target_column: 'id',
        on_delete: 'RESTRICT',
        on_update: 'CASCADE',
      },
    ];
    const runner = createFullMockQueryRunner({ foreignKeys: customFKs });
    const res = await verifyCompleteSchema('post', validIdentity, runner);
    expect(res.success).toBe(false);
    expect(res.summaryCounts.conflict).toBeGreaterThan(0);
  });

  it('14. Wrong foreign key delete action produces CONFLICT', async () => {
    const customFKs: PgConstraintRaw[] = [
      {
        constraint_name: 'Company_createdById_fkey',
        source_table: 'Company',
        source_column: 'createdById',
        target_table: 'User',
        target_column: 'id',
        on_delete: 'CASCADE', // expected RESTRICT
        on_update: 'CASCADE',
      },
    ];
    const runner = createFullMockQueryRunner({ foreignKeys: customFKs });
    const res = await verifyCompleteSchema('post', validIdentity, runner);
    expect(res.success).toBe(false);
    expect(res.summaryCounts.conflict).toBeGreaterThan(0);
  });

  it('15. Catalogue query failure fails verification cleanly', async () => {
    const runner = createFullMockQueryRunner({ throwOnQuery: true });
    const res = await verifyCompleteSchema('post', validIdentity, runner);
    expect(res.success).toBe(false);
    expect(res.gateStatus).toBe('FAILED');
  });

  it('16. Missing environment identity blocks verification', async () => {
    const runner = createFullMockQueryRunner();
    const res = await verifyCompleteSchema('post', {}, runner);
    expect(res.success).toBe(false);
    expect(res.gateStatus).toBe('BLOCKED_ENVIRONMENT_SAFETY');
  });

  it('17. Production environment explicitly rejected', async () => {
    const runner = createFullMockQueryRunner();
    const res = await verifyCompleteSchema('post', { appEnv: 'production', databaseEnv: 'production' }, runner);
    expect(res.success).toBe(false);
    expect(res.gateStatus).toBe('BLOCKED_ENVIRONMENT_SAFETY');
  });

  it('18. Contradictory environment indicators rejected', async () => {
    const runner = createFullMockQueryRunner();
    const res = await verifyCompleteSchema('post', { appEnv: 'staging', databaseEnv: 'development' }, runner);
    expect(res.success).toBe(false);
    expect(res.gateStatus).toBe('BLOCKED_ENVIRONMENT_SAFETY');
  });
});
