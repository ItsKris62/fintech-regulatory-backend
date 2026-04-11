import { describe, expect, it } from 'vitest';
import {
  normalizeSystemConfigPatch,
  resolveRuntimeAIConfigFromSystemConfig,
  sanitizeSystemConfigForAudit,
  toAdminSystemConfig,
} from './system-config';

describe('system config normalization', () => {
  it('maps legacy snake_case keys onto canonical config keys', () => {
    const normalized = normalizeSystemConfigPatch({
      ai_api_key: 'test-api-key',
      ai_daily_cost_limit: '125.5',
      max_queries_per_hour: '75',
      session_timeout_hours: 12,
      maintenance_mode: 'true',
      available_ai_models: '["claude-sonnet-4-6","claude-opus-4-6"]',
    });

    expect(normalized.aiApiKey).toBe('test-api-key');
    expect(normalized.aiDailyCostLimit).toBe(125.5);
    expect(normalized.maxQueriesPerHour).toBe(75);
    expect(normalized.sessionTimeoutHours).toBe(12);
    expect(normalized.maintenanceMode).toBe(true);
    expect(normalized.availableAIModels).toEqual(['claude-sonnet-4-6', 'claude-opus-4-6']);
  });

  it('rejects invalid known values instead of silently corrupting config', () => {
    expect(() => normalizeSystemConfigPatch({ max_queries_per_hour: 'abc' })).toThrow(
      'Expected a numeric value.'
    );
  });

  it('masks AI API keys for admin responses and audit metadata', () => {
    const adminView = toAdminSystemConfig({
      maintenanceMode: false,
      maintenanceMessage: 'Maintenance',
      maxFileUploadMB: 50,
      maxQueriesPerHour: 50,
      maxPoliciesPerHour: 10,
      allowNewRegistrations: true,
      requireEmailVerification: true,
      defaultSubscriptionTier: 'starter',
      supportEmail: 'support@example.com',
      aiApiKey: 'sk-ant-1234567890abcdef',
    });

    expect(adminView.aiApiKey).toBe('');
    expect(adminView.aiApiKeyConfigured).toBe(true);
    expect(adminView.aiApiKeySource).toBe('system_config');
    expect(adminView.aiApiKeyMasked).toBe('sk-a***************cdef');
    expect(sanitizeSystemConfigForAudit({ aiApiKey: 'sk-ant-1234567890abcdef' })).toEqual({
      aiApiKey: 'sk-a***************cdef',
    });
  });

  it('resolves runtime AI settings from stored overrides and allowed models', () => {
    const runtime = resolveRuntimeAIConfigFromSystemConfig(
      {
        aiApiKey: 'runtime-secret-key',
        aiQueryModel: 'claude-opus-4-6',
        aiQueryTemperature: 0.2,
        availableAIModels: ['claude-haiku-4-5-20251001', 'claude-opus-4-6'],
      },
      'query'
    );

    expect(runtime.apiKey).toBe('runtime-secret-key');
    expect(runtime.model).toBe('claude-opus-4-6');
    expect(runtime.temperature).toBe(0.2);
  });

  it('falls back to an allowed default model when a stored model is no longer allowed', () => {
    const runtime = resolveRuntimeAIConfigFromSystemConfig(
      {
        aiApiKey: 'runtime-secret-key',
        aiPolicyModel: 'claude-opus-4-6',
        availableAIModels: ['claude-sonnet-4-6'],
      },
      'policy'
    );

    expect(runtime.model).toBe('claude-sonnet-4-6');
  });
});