import { describe, it, expect } from 'vitest';
import { isSafeTestDatabaseUrl, assertSafeTestDatabase } from './destructive-test-safety';

describe('Destructive Test Database Safety Guard', () => {
  it('strictly rejects production Supabase and AWS URLs', () => {
    const dangerousUrls = [
      'postgresql://postgres:secret@db.abcdef.supabase.co:5432/postgres',
      'postgres://user:pass@pooler.supabase.com:6543/postgres?sslmode=require',
      'postgresql://admin:secret@prod-db.rds.amazonaws.com:5432/sheriabot_production',
      'postgresql://user:pass@dpg-abcdef.render.com/sheriabot_prod',
    ];

    for (const url of dangerousUrls) {
      const check = isSafeTestDatabaseUrl(url);
      expect(check.safe).toBe(false);
      expect(check.reason).toContain('production indicator');
      expect(() => assertSafeTestDatabase(url)).toThrow('DESTRUCTIVE TEST SAFETY VIOLATION');
    }
  });

  it('permits localhost, 127.0.0.1, and local test databases', () => {
    const safeUrls = [
      'postgresql://postgres:postgres@localhost:5432/sheriabot_test',
      'postgresql://postgres:postgres@127.0.0.1:5432/sheriabot_disposable',
      'postgresql://test_user:test_pass@localhost:5433/test_db',
    ];

    for (const url of safeUrls) {
      const check = isSafeTestDatabaseUrl(url);
      expect(check.safe).toBe(true);
      expect(() => assertSafeTestDatabase(url)).not.toThrow();
    }
  });

  it('rejects empty or undefined database URLs', () => {
    expect(isSafeTestDatabaseUrl('').safe).toBe(false);
    expect(isSafeTestDatabaseUrl(undefined).safe).toBe(false);
  });
});
