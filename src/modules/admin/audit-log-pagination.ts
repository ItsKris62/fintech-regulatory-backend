export const AUDIT_LOG_MAX_LIMIT = 200;
export const AUDIT_LOG_DEFAULT_LIMIT = 50;
export const AUDIT_LOG_ORDER_BY = [{ createdAt: 'desc' }, { id: 'desc' }] as const;

export interface AuditLogPage {
  page: number;
  limit: number;
  skip: number;
  totalPages: number;
}

export function resolveAuditLogPage(
  requestedPage: number | undefined,
  requestedLimit: number | undefined,
  total: number,
): AuditLogPage {
  const limit = Math.min(AUDIT_LOG_MAX_LIMIT, Math.max(1, Math.trunc(requestedLimit ?? AUDIT_LOG_DEFAULT_LIMIT)));
  const totalPages = Math.max(1, Math.ceil(Math.max(0, total) / limit));
  const page = Math.min(totalPages, Math.max(1, Math.trunc(requestedPage ?? 1)));
  return { page, limit, skip: (page - 1) * limit, totalPages };
}
