import { describe, it, expect, vi } from 'vitest';
import {
  verifyDatabaseSchema,
  validateDatabaseUrlSafety,
  QueryRunner,
  EXPECTED_SCHEMA,
} from './schema-verifier';

describe('validateDatabaseUrlSafety', () => {
  it('rejects empty or missing DATABASE_URL', () => {
    const res = validateDatabaseUrlSafety('');
    expect(res.safe).toBe(false);
    expect(res.envName).toBe('UNCONFIGURED');
  });

  it('rejects production database URLs', () => {
    const res = validateDatabaseUrlSafety('postgresql://user:pass@prod-db.example.com:5432/sheria_prod');
    expect(res.safe).toBe(false);
    expect(res.envName).toBe('PRODUCTION');
  });

  it('allows staging database URLs', () => {
    const res = validateDatabaseUrlSafety('postgresql://user:pass@staging.example.com:5432/sheria_staging');
    expect(res.safe).toBe(true);
    expect(res.envName).toBe('STAGING');
  });

  it('allows local development URLs', () => {
    const res = validateDatabaseUrlSafety('postgresql://postgres:postgres@localhost:5432/sheria_dev');
    expect(res.safe).toBe(true);
    expect(res.envName).toBe('LOCAL_DEVELOPMENT');
  });
});

describe('verifyDatabaseSchema', () => {
  const createMockQueryRunner = (customTables?: any[], customColumns?: any[], customEnums?: any[]): QueryRunner => {
    const defaultTables = [
      { table_name: 'BlogPost' },
      { table_name: 'MarketingCampaign' },
      { table_name: 'AgentRun' },
      { table_name: 'BlogSourceItem' },
    ];

    const defaultColumns = [
      { table_name: 'BlogPost', column_name: 'id', data_type: 'text', is_nullable: 'NO' },
      { table_name: 'BlogPost', column_name: 'slug', data_type: 'text', is_nullable: 'NO' },
      { table_name: 'BlogPost', column_name: 'title', data_type: 'text', is_nullable: 'NO' },
      { table_name: 'BlogPost', column_name: 'excerpt', data_type: 'text', is_nullable: 'YES' },
      { table_name: 'BlogPost', column_name: 'body', data_type: 'text', is_nullable: 'NO' },
      { table_name: 'BlogPost', column_name: 'status', data_type: 'text', is_nullable: 'NO' },
      { table_name: 'BlogPost', column_name: 'publishedAt', data_type: 'timestamp without time zone', is_nullable: 'YES' },

      { table_name: 'MarketingCampaign', column_name: 'id', data_type: 'text', is_nullable: 'NO' },
      { table_name: 'MarketingCampaign', column_name: 'title', data_type: 'text', is_nullable: 'NO' },
      { table_name: 'MarketingCampaign', column_name: 'templateKey', data_type: 'USER-DEFINED', is_nullable: 'NO' },
      { table_name: 'MarketingCampaign', column_name: 'status', data_type: 'text', is_nullable: 'NO' },
      { table_name: 'MarketingCampaign', column_name: 'approvalId', data_type: 'text', is_nullable: 'YES' },

      { table_name: 'AgentRun', column_name: 'id', data_type: 'text', is_nullable: 'NO' },
      { table_name: 'AgentRun', column_name: 'agentId', data_type: 'text', is_nullable: 'NO' },
      { table_name: 'AgentRun', column_name: 'status', data_type: 'text', is_nullable: 'NO' },

      { table_name: 'BlogSourceItem', column_name: 'id', data_type: 'text', is_nullable: 'NO' },
      { table_name: 'BlogSourceItem', column_name: 'title', data_type: 'text', is_nullable: 'NO' },
      { table_name: 'BlogSourceItem', column_name: 'url', data_type: 'text', is_nullable: 'NO' },
    ];

    const defaultEnums = [
      { enum_name: 'MarketingTemplateKey', enum_value: 'KENYAN_COMPLIANCE_BRIEF' },
      { enum_name: 'AgentCredentialCapability', enum_value: 'CAN_CREATE_CONTENT_DRAFT' },
      { enum_name: 'AgentCredentialCapability', enum_value: 'CAN_GENERATE_DRAFT_CONTENT' },
    ];

    return {
      async queryRaw<T = unknown>(query: string): Promise<T[]> {
        if (query.includes('information_schema.tables')) {
          return (customTables || defaultTables) as T[];
        }
        if (query.includes('information_schema.columns')) {
          return (customColumns || defaultColumns) as T[];
        }
        if (query.includes('pg_enum')) {
          return (customEnums || defaultEnums) as T[];
        }
        return [] as T[];
      },
    };
  };

  it('passes verification when expected tables, columns, and enums exist', async () => {
    const runner = createMockQueryRunner();
    const result = await verifyDatabaseSchema(runner, 'postgresql://user:pass@localhost:5432/sheria_dev');

    expect(result.success).toBe(true);
    expect(result.gateStatus).toBe('PASSED');
    expect(result.missingTables).toHaveLength(0);
    expect(result.missingColumns).toHaveLength(0);
    expect(result.missingEnumValues).toHaveLength(0);
  });

  it('fails verification and lists missing table when a table is missing', async () => {
    const incompleteTables = [{ table_name: 'MarketingCampaign' }];
    const runner = createMockQueryRunner(incompleteTables);

    const result = await verifyDatabaseSchema(runner, 'postgresql://user:pass@localhost:5432/sheria_dev');

    expect(result.success).toBe(false);
    expect(result.gateStatus).toBe('FAILED');
    expect(result.missingTables).toContain('BlogPost');
  });

  it('fails verification when a required column is missing', async () => {
    const incompleteColumns = [
      { table_name: 'BlogPost', column_name: 'id', data_type: 'text', is_nullable: 'NO' },
      // 'slug' column missing
    ];
    const runner = createMockQueryRunner(undefined, incompleteColumns);

    const result = await verifyDatabaseSchema(runner, 'postgresql://user:pass@localhost:5432/sheria_dev');

    expect(result.success).toBe(false);
    expect(result.missingColumns).toEqual(
      expect.arrayContaining([{ table: 'BlogPost', column: 'slug' }])
    );
  });

  it('fails verification when an enum value is missing', async () => {
    const incompleteEnums = [
      { enum_name: 'MarketingTemplateKey', enum_value: 'OTHER_TEMPLATE' },
    ];
    const runner = createMockQueryRunner(undefined, undefined, incompleteEnums);

    const result = await verifyDatabaseSchema(runner, 'postgresql://user:pass@localhost:5432/sheria_dev');

    expect(result.success).toBe(false);
    expect(result.missingEnumValues).toEqual(
      expect.arrayContaining([{ enumName: 'MarketingTemplateKey', missingValue: 'KENYAN_COMPLIANCE_BRIEF' }])
    );
  });

  it('blocks verification when unconfigured DATABASE_URL is provided', async () => {
    const runner = createMockQueryRunner();
    const result = await verifyDatabaseSchema(runner, '');

    expect(result.success).toBe(false);
    expect(result.gateStatus).toBe('BLOCKED_NO_STAGING_URL');
  });
});
