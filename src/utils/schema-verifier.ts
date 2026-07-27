import { logger } from './logger';

export interface ExpectedColumn {
  name: string;
  dataType: string;
  isNullable?: boolean;
}

export interface ExpectedTable {
  tableName: string;
  columns: ExpectedColumn[];
}

export interface ExpectedEnum {
  enumName: string;
  requiredValues: string[];
}

export interface SchemaVerificationResult {
  success: boolean;
  gateStatus: 'PASSED' | 'FAILED' | 'BLOCKED_NO_STAGING_URL' | 'BLOCKED_PRODUCTION_TARGET';
  targetEnvironment: string;
  matchedTables: string[];
  missingTables: string[];
  missingColumns: Array<{ table: string; column: string }>;
  typeMismatches: Array<{ table: string; column: string; expected: string; actual: string }>;
  missingEnumValues: Array<{ enumName: string; missingValue: string }>;
  details: string[];
}

export interface QueryRunner {
  queryRaw<T = unknown>(query: string, ...params: unknown[]): Promise<T[]>;
}

/**
 * Expected Schema Specification for Content, Marketing, and Automation Agent Subsystems
 */
export const EXPECTED_SCHEMA: {
  tables: ExpectedTable[];
  enums: ExpectedEnum[];
} = {
  enums: [
    {
      enumName: 'MarketingTemplateKey',
      requiredValues: ['KENYAN_COMPLIANCE_BRIEF'],
    },
    {
      enumName: 'AgentCredentialCapability',
      requiredValues: ['CAN_CREATE_CONTENT_DRAFT', 'CAN_GENERATE_DRAFT_CONTENT'],
    },
  ],
  tables: [
    {
      tableName: 'BlogPost',
      columns: [
        { name: 'id', dataType: 'text', isNullable: false },
        { name: 'slug', dataType: 'text', isNullable: false },
        { name: 'title', dataType: 'text', isNullable: false },
        { name: 'excerpt', dataType: 'text', isNullable: true },
        { name: 'body', dataType: 'text', isNullable: false },
        { name: 'status', dataType: 'text', isNullable: false },
        { name: 'publishedAt', dataType: 'timestamp', isNullable: true },
      ],
    },
    {
      tableName: 'MarketingCampaign',
      columns: [
        { name: 'id', dataType: 'text', isNullable: false },
        { name: 'title', dataType: 'text', isNullable: false },
        { name: 'templateKey', dataType: 'USER-DEFINED', isNullable: false },
        { name: 'status', dataType: 'text', isNullable: false },
        { name: 'approvalId', dataType: 'text', isNullable: true },
      ],
    },
    {
      tableName: 'AgentRun',
      columns: [
        { name: 'id', dataType: 'text', isNullable: false },
        { name: 'agentId', dataType: 'text', isNullable: false },
        { name: 'status', dataType: 'text', isNullable: false },
      ],
    },
    {
      tableName: 'BlogSourceItem',
      columns: [
        { name: 'id', dataType: 'text', isNullable: false },
        { name: 'title', dataType: 'text', isNullable: false },
        { name: 'url', dataType: 'text', isNullable: false },
      ],
    },
  ],
};

/**
 * Validates database URL safety before establishing read-only catalog connection.
 */
export function validateDatabaseUrlSafety(databaseUrl?: string): { safe: boolean; envName: string; reason?: string } {
  if (!databaseUrl || databaseUrl.trim() === '') {
    return { safe: false, envName: 'UNCONFIGURED', reason: 'DATABASE_URL environment variable is empty or undefined.' };
  }

  const normalized = databaseUrl.toLowerCase();
  if (normalized.includes('prod-db') || (normalized.includes('production') && !normalized.includes('staging'))) {
    return { safe: false, envName: 'PRODUCTION', reason: 'Target DATABASE_URL matches production domain patterns. Direct inspection blocked.' };
  }

  if (normalized.includes('staging') || normalized.includes('localhost') || normalized.includes('127.0.0.1')) {
    return { safe: true, envName: normalized.includes('staging') ? 'STAGING' : 'LOCAL_DEVELOPMENT' };
  }

  return { safe: true, envName: 'CUSTOM_STAGING_OR_TEST' };
}

/**
 * Pure read-only database schema verifier utility.
 * Inspects information_schema.tables, information_schema.columns, and pg_enum.
 */
export async function verifyDatabaseSchema(
  queryRunner?: QueryRunner,
  databaseUrl: string = process.env.DATABASE_URL || ''
): Promise<SchemaVerificationResult> {
  const safety = validateDatabaseUrlSafety(databaseUrl);
  const result: SchemaVerificationResult = {
    success: false,
    gateStatus: 'FAILED',
    targetEnvironment: safety.envName,
    matchedTables: [],
    missingTables: [],
    missingColumns: [],
    typeMismatches: [],
    missingEnumValues: [],
    details: [],
  };

  if (!safety.safe) {
    if (safety.envName === 'PRODUCTION') {
      result.gateStatus = 'BLOCKED_PRODUCTION_TARGET';
    } else {
      result.gateStatus = 'BLOCKED_NO_STAGING_URL';
    }
    result.details.push(`Safety Guardrail Triggered: ${safety.reason}`);
    logger.warn({ type: 'schema_verifier_blocked', safety }, safety.reason);
    return result;
  }

  if (!queryRunner) {
    result.gateStatus = 'BLOCKED_NO_STAGING_URL';
    result.details.push('No active database client query runner provided for catalog inspection.');
    return result;
  }

  try {
    // 1. Inspect existing tables in information_schema
    const existingTablesRaw = await queryRunner.queryRaw<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    const existingTableSet = new Set(existingTablesRaw.map((t) => t.table_name));

    // 2. Inspect existing columns in information_schema
    const existingColumnsRaw = await queryRunner.queryRaw<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(
      `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public'`
    );
    const columnMap = new Map<string, Map<string, { dataType: string; isNullable: boolean }>>();

    for (const col of existingColumnsRaw) {
      if (!columnMap.has(col.table_name)) {
        columnMap.set(col.table_name, new Map());
      }
      columnMap.get(col.table_name)!.set(col.column_name, {
        dataType: col.data_type,
        isNullable: col.is_nullable.toUpperCase() === 'YES',
      });
    }

    // 3. Inspect existing enums in pg_enum
    const existingEnumsRaw = await queryRunner.queryRaw<{ enum_name: string; enum_value: string }>(
      `SELECT t.typname AS enum_name, e.enumlabel AS enum_value 
       FROM pg_type t 
       JOIN pg_enum e ON t.oid = e.enumtypid 
       JOIN pg_namespace n ON n.oid = t.typnamespace 
       WHERE n.nspname = 'public'`
    );
    const enumMap = new Map<string, Set<string>>();
    for (const e of existingEnumsRaw) {
      if (!enumMap.has(e.enum_name)) {
        enumMap.set(e.enum_name, new Set());
      }
      enumMap.get(e.enum_name)!.add(e.enum_value);
    }

    // 4. Verify Tables & Columns
    for (const expectedTable of EXPECTED_SCHEMA.tables) {
      if (!existingTableSet.has(expectedTable.tableName)) {
        result.missingTables.push(expectedTable.tableName);
        result.details.push(`Missing Table: ${expectedTable.tableName}`);
        continue;
      }

      result.matchedTables.push(expectedTable.tableName);
      const actualColumns = columnMap.get(expectedTable.tableName) || new Map();

      for (const expectedCol of expectedTable.columns) {
        const actualCol = actualColumns.get(expectedCol.name);
        if (!actualCol) {
          result.missingColumns.push({ table: expectedTable.tableName, column: expectedCol.name });
          result.details.push(`Missing Column: ${expectedTable.tableName}.${expectedCol.name}`);
        } else {
          // Normalize data type checking (e.g., text, timestamp without time zone -> timestamp)
          const actualTypeNormalized = actualCol.dataType.toLowerCase().includes('timestamp')
            ? 'timestamp'
            : actualCol.dataType.toLowerCase();
          const expectedTypeNormalized = expectedCol.dataType.toLowerCase();

          if (actualTypeNormalized !== expectedTypeNormalized && expectedCol.dataType !== 'USER-DEFINED') {
            result.typeMismatches.push({
              table: expectedTable.tableName,
              column: expectedCol.name,
              expected: expectedCol.dataType,
              actual: actualCol.dataType,
            });
            result.details.push(`Type Mismatch: ${expectedTable.tableName}.${expectedCol.name} (Expected: ${expectedCol.dataType}, Got: ${actualCol.dataType})`);
          }
        }
      }
    }

    // 5. Verify Enums
    for (const expectedEnum of EXPECTED_SCHEMA.enums) {
      const actualValues = enumMap.get(expectedEnum.enumName) || new Set();
      for (const reqValue of expectedEnum.requiredValues) {
        if (!actualValues.has(reqValue)) {
          result.missingEnumValues.push({ enumName: expectedEnum.enumName, missingValue: reqValue });
          result.details.push(`Missing Enum Value: ${expectedEnum.enumName}.${reqValue}`);
        }
      }
    }

    // Determine final success state
    const hasDiscrepancies =
      result.missingTables.length > 0 ||
      result.missingColumns.length > 0 ||
      result.typeMismatches.length > 0 ||
      result.missingEnumValues.length > 0;

    result.success = !hasDiscrepancies;
    result.gateStatus = result.success ? 'PASSED' : 'FAILED';

    if (result.success) {
      result.details.push('All expected schema tables, columns, and enum values verified successfully.');
    }
  } catch (error: any) {
    result.success = false;
    result.gateStatus = 'FAILED';
    result.details.push(`Catalog Inspection Query Failed: ${error.message}`);
    logger.error({ type: 'schema_verifier_error', error: error.message }, 'Failed during read-only catalog query execution.');
  }

  return result;
}
