import { aiConfig } from '@/config/ai.config';
import { SESSION_CONFIG } from '@/config/session';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import {
  ADMIN_CONSTANTS,
  DEFAULT_SYSTEM_CONFIG,
  type SystemConfig,
} from '@/modules/admin/admin.types';
import { maskSensitive } from '@/utils/helpers';
import { logger } from '@/utils/logger';

type SystemConfigValueType = 'string' | 'number' | 'boolean' | 'json';
type RuntimeAIUseCase = 'policy' | 'checklist' | 'query' | 'verification';

export interface RuntimeAIConfig {
  apiKey: string;
  model: string;
  temperature: number;
}

interface SystemConfigDefinition {
  key: string;
  aliases?: readonly string[];
  type: SystemConfigValueType;
  category: string;
  description: string;
  defaultValue: unknown;
}

const SYSTEM_CONFIG_CACHE_KEY = 'admin:system_config';
const SYSTEM_CONFIG_PERSISTED_KEY = 'admin:system_config:persisted';
const { CACHE_TTL } = ADMIN_CONSTANTS;

const SYSTEM_CONFIG_DEFAULTS: Record<string, unknown> = {
  ...DEFAULT_SYSTEM_CONFIG,
  aiApiKey: '',
  aiDailyCostLimit: aiConfig.costs.dailyLimit,
  aiPolicyModel: aiConfig.models.policyGeneration,
  aiQueryModel: aiConfig.models.complianceQuery,
  aiVerificationModel: aiConfig.models.citationVerification,
  aiComplexAnalysisModel: aiConfig.models.complexAnalysis,
  aiPolicyTemperature: aiConfig.parameters.policyTemperature,
  aiQueryTemperature: aiConfig.parameters.queryTemperature,
  sessionTimeoutHours: SESSION_CONFIG.ABSOLUTE_TIMEOUT_SECONDS / 3600,
  passwordMinLength: 10,
  automatedBackupsEnabled: true,
  resourceUsageAlertThreshold: 80,
  webhookFailureAlertThreshold: 5,
  securityAlertEmail: DEFAULT_SYSTEM_CONFIG.supportEmail,
  availableAIModels: [
    aiConfig.models.policyGeneration,
    aiConfig.models.complianceQuery,
    aiConfig.models.citationVerification,
    aiConfig.models.complexAnalysis,
  ],
};

export const SYSTEM_CONFIG_DEFINITIONS: readonly SystemConfigDefinition[] = [
  { key: 'maintenanceMode', aliases: ['maintenance_mode'], type: 'boolean', category: 'general', description: 'Enable maintenance mode across the platform.', defaultValue: SYSTEM_CONFIG_DEFAULTS.maintenanceMode },
  { key: 'maintenanceMessage', aliases: ['maintenance_message'], type: 'string', category: 'general', description: 'Customer-facing maintenance notice.', defaultValue: SYSTEM_CONFIG_DEFAULTS.maintenanceMessage },
  { key: 'maxFileUploadMB', aliases: ['max_upload_size_mb'], type: 'number', category: 'storage', description: 'Maximum file upload size in MB.', defaultValue: SYSTEM_CONFIG_DEFAULTS.maxFileUploadMB },
  { key: 'maxQueriesPerHour', aliases: ['max_queries_per_hour'], type: 'number', category: 'ai', description: 'Maximum compliance queries allowed per user per hour.', defaultValue: SYSTEM_CONFIG_DEFAULTS.maxQueriesPerHour },
  { key: 'maxPoliciesPerHour', aliases: ['max_policies_per_hour'], type: 'number', category: 'ai', description: 'Maximum policy generations allowed per user per hour.', defaultValue: SYSTEM_CONFIG_DEFAULTS.maxPoliciesPerHour },
  { key: 'aiApiKey', aliases: ['ai_api_key'], type: 'string', category: 'ai', description: 'Override Anthropic API key for live AI requests.', defaultValue: SYSTEM_CONFIG_DEFAULTS.aiApiKey },
  { key: 'aiDailyCostLimit', aliases: ['ai_daily_cost_limit'], type: 'number', category: 'ai', description: 'Maximum estimated AI spend per day in USD.', defaultValue: SYSTEM_CONFIG_DEFAULTS.aiDailyCostLimit },
  { key: 'aiPolicyModel', aliases: ['ai_policy_model'], type: 'string', category: 'ai', description: 'Default model for policy and checklist generation.', defaultValue: SYSTEM_CONFIG_DEFAULTS.aiPolicyModel },
  { key: 'aiQueryModel', aliases: ['ai_query_model'], type: 'string', category: 'ai', description: 'Default model for compliance query responses.', defaultValue: SYSTEM_CONFIG_DEFAULTS.aiQueryModel },
  { key: 'aiVerificationModel', aliases: ['ai_verification_model'], type: 'string', category: 'ai', description: 'Default model for citation verification.', defaultValue: SYSTEM_CONFIG_DEFAULTS.aiVerificationModel },
  { key: 'aiComplexAnalysisModel', aliases: ['ai_complex_analysis_model'], type: 'string', category: 'ai', description: 'Default model for long-form complex analysis.', defaultValue: SYSTEM_CONFIG_DEFAULTS.aiComplexAnalysisModel },
  { key: 'aiPolicyTemperature', aliases: ['ai_policy_temperature'], type: 'number', category: 'ai', description: 'Sampling temperature for policy generation.', defaultValue: SYSTEM_CONFIG_DEFAULTS.aiPolicyTemperature },
  { key: 'aiQueryTemperature', aliases: ['ai_query_temperature'], type: 'number', category: 'ai', description: 'Sampling temperature for compliance queries.', defaultValue: SYSTEM_CONFIG_DEFAULTS.aiQueryTemperature },
  { key: 'availableAIModels', aliases: ['available_ai_models'], type: 'json', category: 'ai', description: 'Allow-list of AI models exposed to administrators.', defaultValue: SYSTEM_CONFIG_DEFAULTS.availableAIModels },
  { key: 'allowNewRegistrations', aliases: ['allow_new_registrations'], type: 'boolean', category: 'general', description: 'Allow new organizations to self-register.', defaultValue: SYSTEM_CONFIG_DEFAULTS.allowNewRegistrations },
  { key: 'requireEmailVerification', aliases: ['require_email_verification'], type: 'boolean', category: 'security', description: 'Require email verification before access is granted.', defaultValue: SYSTEM_CONFIG_DEFAULTS.requireEmailVerification },
  { key: 'defaultSubscriptionTier', aliases: ['default_subscription_tier'], type: 'string', category: 'billing', description: 'Default subscription tier for newly provisioned organizations.', defaultValue: SYSTEM_CONFIG_DEFAULTS.defaultSubscriptionTier },
  { key: 'supportEmail', aliases: ['support_email'], type: 'string', category: 'general', description: 'Primary support mailbox surfaced in admin workflows.', defaultValue: SYSTEM_CONFIG_DEFAULTS.supportEmail },
  { key: 'sessionTimeoutHours', aliases: ['session_timeout_hours'], type: 'number', category: 'security', description: 'Absolute session validity period in hours.', defaultValue: SYSTEM_CONFIG_DEFAULTS.sessionTimeoutHours },
  { key: 'passwordMinLength', aliases: ['password_min_length'], type: 'number', category: 'security', description: 'Minimum password length for newly created credentials.', defaultValue: SYSTEM_CONFIG_DEFAULTS.passwordMinLength },
  { key: 'automatedBackupsEnabled', aliases: ['automated_backups_enabled'], type: 'boolean', category: 'storage', description: 'Whether scheduled backup automation is enabled.', defaultValue: SYSTEM_CONFIG_DEFAULTS.automatedBackupsEnabled },
  { key: 'resourceUsageAlertThreshold', aliases: ['resource_usage_alert_threshold'], type: 'number', category: 'general', description: 'Threshold percentage for proactive resource-usage alerts.', defaultValue: SYSTEM_CONFIG_DEFAULTS.resourceUsageAlertThreshold },
  { key: 'webhookFailureAlertThreshold', aliases: ['webhook_failure_alert_threshold'], type: 'number', category: 'general', description: 'Consecutive webhook delivery failures before alerting admins.', defaultValue: SYSTEM_CONFIG_DEFAULTS.webhookFailureAlertThreshold },
  { key: 'securityAlertEmail', aliases: ['security_alert_email'], type: 'string', category: 'security', description: 'Mailbox that receives system security alerts.', defaultValue: SYSTEM_CONFIG_DEFAULTS.securityAlertEmail },
  { key: 'billingPlanOverrides', aliases: ['billing_plan_overrides'], type: 'json', category: 'billing', description: 'Runtime overrides for self-serve billing plan prices and Stripe price IDs.', defaultValue: SYSTEM_CONFIG_DEFAULTS.billingPlanOverrides },
];

const definitionByKey = new Map(SYSTEM_CONFIG_DEFINITIONS.map((definition) => [definition.key, definition]));
const aliasToPrimaryKey = new Map(
  SYSTEM_CONFIG_DEFINITIONS.flatMap((definition) =>
    (definition.aliases ?? []).map((alias) => [alias, definition.key] as const)
  )
);

function toPrimaryKey(key: string): string {
  return aliasToPrimaryKey.get(key) ?? key;
}

function parseBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1;
  throw new TypeError('Expected a boolean value.');
}

function getTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseAvailableAIModels(value: unknown): string[] {
  const source = Array.isArray(value) ? value : SYSTEM_CONFIG_DEFAULTS.availableAIModels;
  const uniqueModels = new Set<string>();

  for (const entry of source as unknown[]) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    uniqueModels.add(trimmed);
  }

  if (uniqueModels.size === 0) {
    return [...(SYSTEM_CONFIG_DEFAULTS.availableAIModels as string[])];
  }

  return [...uniqueModels];
}

function resolveAllowedModel(candidate: unknown, fallback: string, allowedModels: string[]): string {
  const normalizedCandidate = getTrimmedString(candidate);
  if (normalizedCandidate && allowedModels.includes(normalizedCandidate)) {
    return normalizedCandidate;
  }

  if (allowedModels.includes(fallback)) return fallback;
  return allowedModels[0] ?? fallback;
}

function normalizeConfiguredValue(definition: SystemConfigDefinition, value: unknown): unknown {
  switch (definition.type) {
    case 'boolean':
      return parseBoolean(value);
    case 'number': {
      const parsed = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(parsed)) throw new TypeError('Expected a numeric value.');
      return parsed;
    }
    case 'json': {
      if (typeof value === 'string') return JSON.parse(value);
      return value;
    }
    case 'string':
    default:
      return String(value ?? '');
  }
}

function deserializeStoredValue(type: SystemConfigValueType, rawValue: unknown): unknown {
  if (rawValue === null || rawValue === undefined) return rawValue;
  switch (type) {
    case 'boolean':
      return parseBoolean(rawValue);
    case 'number': {
      const parsed = typeof rawValue === 'number' ? rawValue : Number(rawValue);
      if (!Number.isFinite(parsed)) throw new TypeError('Stored numeric config value is invalid.');
      return parsed;
    }
    case 'json':
      return typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
    case 'string':
    default:
      return String(rawValue);
  }
}

function inferValueType(value: unknown): SystemConfigValueType {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value) || (value !== null && typeof value === 'object')) return 'json';
  return 'string';
}

function serializeValue(type: SystemConfigValueType, value: unknown): string {
  if (type === 'json') return JSON.stringify(value ?? null);
  return String(value ?? '');
}

function normalizeConfigObject(source: Record<string, unknown>, strict: boolean): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const primaryKey = toPrimaryKey(rawKey);
    const definition = definitionByKey.get(primaryKey);
    if (!definition) {
      normalized[primaryKey] = rawValue;
      continue;
    }
    try {
      normalized[primaryKey] = normalizeConfiguredValue(definition, rawValue);
    } catch (error) {
      if (strict) throw error;
      logger.warn({ type: 'system_config_value_normalized_to_default', key: rawKey, primaryKey, error: error instanceof Error ? error.message : String(error) });
      normalized[primaryKey] = definition.defaultValue;
    }
  }
  return normalized;
}

function deserializeDatabaseRows(
  rows: Array<{ key: string; value: string; type: string }>
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  const sortedRows = [...rows].sort((left, right) => {
    const leftPrimary = toPrimaryKey(left.key);
    const rightPrimary = toPrimaryKey(right.key);
    const leftIsPrimary = left.key === leftPrimary;
    const rightIsPrimary = right.key === rightPrimary;
    return Number(leftIsPrimary) - Number(rightIsPrimary);
  });

  for (const row of sortedRows) {
    const primaryKey = toPrimaryKey(row.key);
    const definition = definitionByKey.get(primaryKey);
    const type = (definition?.type ?? row.type ?? 'string') as SystemConfigValueType;
    try {
      normalized[primaryKey] = deserializeStoredValue(type, row.value);
    } catch (error) {
      logger.warn({ type: 'system_config_db_value_invalid', key: row.key, primaryKey, error: error instanceof Error ? error.message : String(error) });
      if (definition) normalized[primaryKey] = definition.defaultValue;
    }
  }
  return normalized;
}

function parseSerializedConfig(rawValue: unknown): Record<string, unknown> | null {
  if (!rawValue) return null;
  if (typeof rawValue === 'string') {
    try {
      const parsed = JSON.parse(rawValue) as Record<string, unknown>;
      return normalizeConfigObject(parsed, false);
    } catch (error) {
      logger.warn({ type: 'system_config_cache_parse_failed', error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }
  if (typeof rawValue === 'object' && !Array.isArray(rawValue)) {
    return normalizeConfigObject(rawValue as Record<string, unknown>, false);
  }
  return null;
}

function applyAliases(config: Record<string, unknown>): SystemConfig {
  const snapshot: Record<string, unknown> = { ...SYSTEM_CONFIG_DEFAULTS, ...config };
  for (const definition of SYSTEM_CONFIG_DEFINITIONS) {
    const value = snapshot[definition.key];
    if (value === undefined) continue;
    for (const alias of definition.aliases ?? []) snapshot[alias] = value;
  }
  return snapshot as SystemConfig;
}

async function persistDatabaseRows(
  config: Record<string, unknown>,
  keys: string[],
  updatedBy?: string
): Promise<void> {
  const operations = keys.flatMap((rawKey) => {
    const primaryKey = toPrimaryKey(rawKey);
    const definition = definitionByKey.get(primaryKey);
    const value = config[primaryKey];
    const type = definition?.type ?? inferValueType(value);
    const category = definition?.category ?? 'general';
    const description = definition?.description ?? null;
    const entries = [primaryKey, ...(definition?.aliases ?? [])];
    return entries.map((key) => prisma.systemConfig.upsert({
      where: { key },
      update: {
        value: serializeValue(type, value),
        type,
        category,
        description,
        updatedBy,
      },
      create: {
        key,
        value: serializeValue(type, value),
        type,
        category,
        description,
        updatedBy,
      },
    }));
  });

  if (operations.length > 0) {
    await prisma.$transaction(operations);
  }
}

export function normalizeSystemConfigPatch(config: Record<string, unknown>): Record<string, unknown> {
  return normalizeConfigObject(config, true);
}

export function sanitizeSystemConfigForAudit(config: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...config };

  for (const key of ['aiApiKey', 'ai_api_key']) {
    const value = getTrimmedString(sanitized[key]);
    if (!value) {
      delete sanitized[key];
      continue;
    }
    sanitized[key] = maskSensitive(value, 4);
  }

  return sanitized;
}

export function toAdminSystemConfig(config: SystemConfig): SystemConfig {
  const storedApiKey = getTrimmedString(config.aiApiKey);
  const environmentApiKey = getTrimmedString(aiConfig.api.key);
  const activeApiKey = storedApiKey ?? environmentApiKey;
  const apiKeySource = storedApiKey ? 'system_config' : environmentApiKey ? 'environment' : 'none';

  return {
    ...config,
    aiApiKey: '',
    ai_api_key: '',
    aiApiKeyMasked: activeApiKey ? maskSensitive(activeApiKey, 4) : null,
    ai_api_key_masked: activeApiKey ? maskSensitive(activeApiKey, 4) : null,
    aiApiKeyConfigured: Boolean(activeApiKey),
    ai_api_key_configured: Boolean(activeApiKey),
    aiApiKeySource: apiKeySource,
    ai_api_key_source: apiKeySource,
  } as SystemConfig;
}

export function resolveRuntimeAIConfigFromSystemConfig(
  config: Partial<SystemConfig>,
  useCase: RuntimeAIUseCase
): RuntimeAIConfig {
  const storedApiKey = getTrimmedString(config.aiApiKey);
  const environmentApiKey = getTrimmedString(aiConfig.api.key);
  const apiKey = storedApiKey ?? environmentApiKey;

  if (!apiKey) {
    throw new Error('Anthropic API key is not configured.');
  }

  const availableModels = parseAvailableAIModels(config.availableAIModels);

  if (useCase === 'policy' || useCase === 'checklist') {
    return {
      apiKey,
      model: resolveAllowedModel(config.aiPolicyModel, aiConfig.models.policyGeneration, availableModels),
      temperature: typeof config.aiPolicyTemperature === 'number'
        ? config.aiPolicyTemperature
        : aiConfig.parameters.policyTemperature,
    };
  }

  if (useCase === 'verification') {
    return {
      apiKey,
      model: resolveAllowedModel(config.aiVerificationModel, aiConfig.models.citationVerification, availableModels),
      temperature: typeof config.aiQueryTemperature === 'number'
        ? config.aiQueryTemperature
        : aiConfig.parameters.queryTemperature,
    };
  }

  return {
    apiKey,
    model: resolveAllowedModel(config.aiQueryModel, aiConfig.models.complianceQuery, availableModels),
    temperature: typeof config.aiQueryTemperature === 'number'
      ? config.aiQueryTemperature
      : aiConfig.parameters.queryTemperature,
  };
}

export async function loadSystemConfig(options?: { syncDefinitions?: boolean }): Promise<SystemConfig> {
  const cached = parseSerializedConfig(await redis.get<string>(SYSTEM_CONFIG_CACHE_KEY));
  if (cached) return applyAliases(cached);

  const [persistedRaw, dbRows] = await Promise.all([
    redis.get<string>(SYSTEM_CONFIG_PERSISTED_KEY),
    prisma.systemConfig.findMany({ select: { key: true, value: true, type: true } }).catch((error: unknown) => {
      logger.warn({ type: 'system_config_db_read_failed', error: error instanceof Error ? error.message : String(error) });
      return [];
    }),
  ]);

  const persisted = parseSerializedConfig(persistedRaw) ?? {};
  const fromDatabase = deserializeDatabaseRows(dbRows);
  const snapshot = applyAliases({ ...SYSTEM_CONFIG_DEFAULTS, ...persisted, ...fromDatabase });
  const serialized = JSON.stringify(snapshot);

  await Promise.all([
    redis.set(SYSTEM_CONFIG_PERSISTED_KEY, serialized),
    redis.set(SYSTEM_CONFIG_CACHE_KEY, serialized, { ex: CACHE_TTL.SYSTEM_CONFIG }),
  ]);

  if (options?.syncDefinitions) {
    await persistDatabaseRows(snapshot, SYSTEM_CONFIG_DEFINITIONS.map((definition) => definition.key)).catch((error: unknown) => {
      logger.warn({ type: 'system_config_definition_sync_failed', error: error instanceof Error ? error.message : String(error) });
    });
  }

  return snapshot;
}

export async function updateSystemConfigSnapshot(
  config: Record<string, unknown>,
  updatedBy?: string
): Promise<SystemConfig> {
  const existing = await loadSystemConfig();
  const updated = applyAliases({
    ...normalizeConfigObject(existing as Record<string, unknown>, false),
    ...normalizeSystemConfigPatch(config),
  });
  const changedKeys = [...new Set(Object.keys(normalizeSystemConfigPatch(config)).map((key) => toPrimaryKey(key)))];
  const serialized = JSON.stringify(updated);

  await Promise.all([
    redis.set(SYSTEM_CONFIG_PERSISTED_KEY, serialized),
    redis.set(SYSTEM_CONFIG_CACHE_KEY, serialized, { ex: CACHE_TTL.SYSTEM_CONFIG }),
    persistDatabaseRows(updated, changedKeys, updatedBy),
  ]);

  return updated;
}

export async function getSystemConfigNumber(key: string, fallback: number): Promise<number> {
  const config = await loadSystemConfig();
  const value = config[toPrimaryKey(key)] ?? config[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export async function getRuntimeAIConfig(
  useCase: RuntimeAIUseCase
): Promise<RuntimeAIConfig> {
  const config = await loadSystemConfig();
  return resolveRuntimeAIConfigFromSystemConfig(config, useCase);
}