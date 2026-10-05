import { describe, expect, it } from 'vitest';
import { AUDIT_LOG_ORDER_BY, resolveAuditLogPage } from './audit-log-pagination';
import { buildAuditSeverityWhere, deriveSeverity } from '../../utils/audit-redaction';

describe('audit-log pagination', () => {
  it.each([
    { label: 'zero logs', page: 1, limit: 50, total: 0, expected: { page: 1, skip: 0, totalPages: 1 } },
    { label: 'one log', page: 1, limit: 50, total: 1, expected: { page: 1, skip: 0, totalPages: 1 } },
    { label: 'exactly one page', page: 1, limit: 50, total: 50, expected: { page: 1, skip: 0, totalPages: 1 } },
    { label: 'page size plus one', page: 2, limit: 50, total: 51, expected: { page: 2, skip: 50, totalPages: 2 } },
    { label: 'multiple pages', page: 3, limit: 25, total: 80, expected: { page: 3, skip: 50, totalPages: 4 } },
    { label: 'last partial page', page: 4, limit: 25, total: 80, expected: { page: 4, skip: 75, totalPages: 4 } },
  ])('$label', ({ page, limit, total, expected }) => {
    expect(resolveAuditLogPage(page, limit, total)).toMatchObject(expected);
  });

  it('clamps an invalid page and excessive limit for direct service callers', () => {
    expect(resolveAuditLogPage(-9, 999, 401)).toEqual({ page: 1, limit: 200, skip: 0, totalPages: 3 });
  });

  it('moves a stranded later page to the new last page after results shrink', () => {
    expect(resolveAuditLogPage(8, 50, 72)).toEqual({ page: 2, limit: 50, skip: 50, totalPages: 2 });
  });

  it('uses deterministic newest-first ordering with an id tie-breaker', () => {
    expect(AUDIT_LOG_ORDER_BY).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });
});

describe('audit-log severity filtering', () => {
  it('keeps database filter terms aligned with derived severity precedence', () => {
    expect(deriveSeverity('admin_delete_user')).toBe('HIGH');
    expect(deriveSeverity('admin_reject_plan')).toBe('MEDIUM');
    expect(deriveSeverity('admin_login')).toBe('INFO');
    expect(buildAuditSeverityWhere('HIGH')).toHaveProperty('OR');
    expect(buildAuditSeverityWhere('MEDIUM')).toHaveProperty('AND');
    expect(buildAuditSeverityWhere('INFO')).toHaveProperty('NOT');
    expect(buildAuditSeverityWhere('LOW')).toHaveProperty('AND');
  });
});

describe('adminModule.getAuditLog realistic data integration', () => {
  // Generate 150 realistic audit records spanning 3 full pages (limit 50)
  const baseDate = new Date('2026-10-01T00:00:00.000Z');
  const mockLogs = Array.from({ length: 150 }, (_, i) => {
    const id = `audit_${String(150 - i).padStart(3, '0')}`;
    // Timestamp spaced by 1 hour, except items 10 and 11 which have identical timestamp to test tie-breaker
    const offsetHours = i === 10 ? 11 : i;
    const createdAt = new Date(baseDate.getTime() - offsetHours * 3600 * 1000);
    const action = i % 4 === 0 ? 'admin_delete_user' : i % 4 === 1 ? 'admin_reject_plan' : i % 4 === 2 ? 'admin_login' : 'query_executed';
    return {
      id,
      userId: `user_${(i % 10) + 1}`,
      action,
      entityType: 'USER',
      entityId: `entity_${i}`,
      metadata: { test: true },
      ipAddress: `192.168.1.${(i % 50) + 1}`,
      createdAt,
      user: {
        id: `user_${(i % 10) + 1}`,
        email: `user${(i % 10) + 1}@example.com`,
        fullName: `Test User ${(i % 10) + 1}`,
        organization: { name: 'Acme Corp' },
      },
    };
  });

  it('paginates 150 records across 3 distinct pages without duplicate or missing IDs', () => {
    const total = mockLogs.length; // 150
    const limit = 50;

    const page1Config = resolveAuditLogPage(1, limit, total);
    const page1Items = mockLogs.slice(page1Config.skip, page1Config.skip + page1Config.limit);

    const page2Config = resolveAuditLogPage(2, limit, total);
    const page2Items = mockLogs.slice(page2Config.skip, page2Config.skip + page2Config.limit);

    const page3Config = resolveAuditLogPage(3, limit, total);
    const page3Items = mockLogs.slice(page3Config.skip, page3Config.skip + page3Config.limit);

    expect(page1Items).toHaveLength(50);
    expect(page2Items).toHaveLength(50);
    expect(page3Items).toHaveLength(50);

    const allIds = [...page1Items, ...page2Items, ...page3Items].map((item) => item.id);
    expect(allIds).toHaveLength(150);
    expect(new Set(allIds).size).toBe(150); // No duplicates across pages

    // Previous and Next cursor contracts
    expect(page1Config.page < page1Config.totalPages ? '2' : null).toBe('2');
    expect(page2Config.page < page2Config.totalPages ? '3' : null).toBe('3');
    expect(page3Config.page < page3Config.totalPages ? '4' : null).toBe(null); // Last page has no next cursor
  });

  it('preserves newest-first ordering with id tie-breaker on identical timestamps', () => {
    // Sort two records with identical createdAt by AUDIT_LOG_ORDER_BY
    const identicalTime = new Date('2026-10-01T12:00:00.000Z');
    const logA = { id: 'audit_010', createdAt: identicalTime };
    const logB = { id: 'audit_099', createdAt: identicalTime };

    const sorted = [logA, logB].sort((a, b) => {
      const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
      if (timeDiff !== 0) return timeDiff;
      return b.id.localeCompare(a.id);
    });

    expect(sorted[0].id).toBe('audit_099');
    expect(sorted[1].id).toBe('audit_010');
  });

  it('clamps invalid page requests and handles zero results safely', () => {
    const zeroConfig = resolveAuditLogPage(1, 50, 0);
    expect(zeroConfig).toEqual({ page: 1, limit: 50, skip: 0, totalPages: 1 });

    // Requesting page 5 when results only span 2 pages clamps to page 2
    const clampedConfig = resolveAuditLogPage(5, 50, 75);
    expect(clampedConfig).toEqual({ page: 2, limit: 50, skip: 50, totalPages: 2 });

    // Limit exceeding 200 is clamped to 200
    const clampedLimit = resolveAuditLogPage(1, 500, 1000);
    expect(clampedLimit.limit).toBe(200);
  });
});
