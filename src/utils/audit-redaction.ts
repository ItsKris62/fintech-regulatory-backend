/**
 * Utility for safely redacting sensitive metadata in audit logs.
 */

const REDACTED = "[REDACTED]";

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
  if (
    normalizedAction.includes("delete") ||
    normalizedAction.includes("role") ||
    normalizedAction.includes("admin_role") ||
    normalizedAction.includes("payment_override") ||
    normalizedAction.includes("revoke") ||
    normalizedAction.includes("security") ||
    normalizedAction.includes("maintenance") ||
    normalizedAction.includes("export")
  ) {
    return "HIGH";
  }

  // Warning events
  if (
    normalizedAction.includes("fail") ||
    normalizedAction.includes("error") ||
    normalizedAction.includes("anomaly") ||
    normalizedAction.includes("suspend") ||
    normalizedAction.includes("plan") ||
    normalizedAction.includes("reject")
  ) {
    return "MEDIUM";
  }

  // Info events (default)
  return "INFO";
}
