/**
 * Utility for safely redacting sensitive metadata in audit logs.
 */

const REDACTED = "[REDACTED]";

export const AUDIT_HIGH_SEVERITY_TERMS = [
  "delete", "role", "admin_role", "payment_override", "revoke", "security", "maintenance", "export",
] as const;
export const AUDIT_MEDIUM_SEVERITY_TERMS = [
  "fail", "error", "anomaly", "suspend", "plan", "reject",
] as const;

const SENSITIVE_KEYS = new Set([
  "password",
  "token",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "auth",
  "cookie",
  "apikey",
  "secret",
  "privatekey",
  "connectionstring",
  "databaseurl",
  "webhooksecret",
  "session",
  "jwt",
  "bearer",
  "credential",
]);

/**
 * Checks if a key name is considered sensitive (case-insensitive partial match).
 */
function isSensitiveKey(key: string): boolean {
  const normalizedKey = key.toLowerCase();
  for (const sensitive of SENSITIVE_KEYS) {
    if (normalizedKey.includes(sensitive)) {
      return true;
    }
  }
  return false;
}

/**
 * Checks if a string value looks like a sensitive token (Bearer token, JWT, API key).
 */
function containsSensitivePattern(value: string): boolean {
  // Bearer token
  if (/bearer\s+[\w-]+\.[\w-]+\.[\w-]+/i.test(value)) return true;
  if (/bearer\s+[a-zA-Z0-9_=-]+/i.test(value)) return true;
  
  // JWT
  if (/eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/.test(value)) return true;
  
  // Generic high-entropy strings often used for API keys/secrets that might leak in URLs
  // (Being conservative here to avoid false positives, so mainly relying on explicit patterns)
  if (value.includes("x-api-key") || value.includes("api_key")) return true;

  return false;
}

/**
 * Safely and recursively redacts sensitive information from an unknown payload.
 * Does not mutate the original object.
 */
export function redactAuditMetadata(metadata: unknown): unknown {
  try {
    if (metadata === null || metadata === undefined) {
      return metadata;
    }

    if (typeof metadata === "string") {
      if (containsSensitivePattern(metadata)) {
        return REDACTED;
      }
      return metadata;
    }

    if (typeof metadata === "number" || typeof metadata === "boolean") {
      return metadata;
    }

    if (Array.isArray(metadata)) {
      return metadata.map((item) => redactAuditMetadata(item));
    }

    if (typeof metadata === "object") {
      const redactedObj: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(metadata)) {
        if (isSensitiveKey(key)) {
          redactedObj[key] = REDACTED;
        } else {
          redactedObj[key] = redactAuditMetadata(value);
        }
      }
      return redactedObj;
    }

    // Functions, symbols, etc. (should not generally appear in JSON, but just in case)
    return "[UNSUPPORTED_TYPE]";
  } catch (error) {
    // Never throw from redaction.
    return "[REDACTION_ERROR]";
  }
}

/**
 * Deterministically derives the severity of an audit event based on its action name.
 */
export function deriveSeverity(action: string): "HIGH" | "MEDIUM" | "LOW" | "INFO" {
  const normalizedAction = action.toLowerCase();

  // Critical events
  if (AUDIT_HIGH_SEVERITY_TERMS.some((term) => normalizedAction.includes(term))) {
    return "HIGH";
  }

  // Warning events
  if (AUDIT_MEDIUM_SEVERITY_TERMS.some((term) => normalizedAction.includes(term))) {
    return "MEDIUM";
  }

  // Info events (default)
  return "INFO";
}

/** Prisma-compatible filter that mirrors deriveSeverity without loading rows into memory. */
export function buildAuditSeverityWhere(severity: "HIGH" | "MEDIUM" | "LOW" | "INFO"): Record<string, unknown> {
  const high = AUDIT_HIGH_SEVERITY_TERMS.map((term) => ({ action: { contains: term, mode: "insensitive" } }));
  const medium = AUDIT_MEDIUM_SEVERITY_TERMS.map((term) => ({ action: { contains: term, mode: "insensitive" } }));

  if (severity === "HIGH") return { OR: high };
  if (severity === "MEDIUM") return { AND: [{ OR: medium }, { NOT: { OR: high } }] };
  if (severity === "LOW") return { AND: [{ id: { equals: "" } }, { id: { not: "" } }] };
  return { NOT: { OR: [...high, ...medium] } };
}
