/**
 * Metadata/text sanitization for ContentOpsAlert (Pack 1 Stage C4). Allows
 * only short structured pointers - IDs, counts, scores, enum values, booleans,
 * short machine-readable reason codes. Rejects/strips anything that could
 * carry article bodies, source content, prompts, raw model output,
 * credentials, tokens, recipient lists, or rendered HTML.
 *
 * Deliberately conservative: only flat scalar values are allowed in metadata
 * (no nested objects/arrays) - if a future stage needs e.g. an array of
 * source IDs, that is a considered schema/contract decision to make then,
 * not something this sanitizer should silently allow through today.
 */

const MAX_SUMMARY_LENGTH = 2000;
const MAX_METADATA_STRING_VALUE_LENGTH = 500;
const MAX_METADATA_JSON_LENGTH = 4000;

// Key names that must never appear in alert metadata, regardless of value shape.
const FORBIDDEN_METADATA_KEY_PATTERN = /token|secret|credential|password|prompt|html|body|content|cookie|authoriz/i;

function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, '');
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/** Sanitizes a free-text field (title/summary/resolutionNote) - strips HTML tags, caps length. */
export function sanitizeAlertText(text: string, maxLength: number = MAX_SUMMARY_LENGTH): string {
  return truncate(stripHtml(text), maxLength);
}

function sanitizeMetadataScalar(value: unknown): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return truncate(stripHtml(value), MAX_METADATA_STRING_VALUE_LENGTH);
  // Arrays, nested objects, functions, undefined-shaped values - not allowed.
  return undefined;
}

export interface SanitizeMetadataResult {
  metadata: Record<string, string | number | boolean | null>;
  droppedKeys: string[];
}

/**
 * Sanitizes an alert metadata object down to short scalar pointers only.
 * Silently drops (does not throw on) forbidden keys and unsupported value
 * shapes - callers can inspect `droppedKeys` if they need to know what was
 * stripped. Caps the final serialized size; if still oversized after
 * per-field truncation, returns a minimal marker rather than an arbitrarily
 * truncated (and therefore potentially misleading) JSON blob.
 */
export function sanitizeAlertMetadata(metadata: Record<string, unknown> | undefined | null): SanitizeMetadataResult {
  if (!metadata) return { metadata: {}, droppedKeys: [] };

  const result: Record<string, string | number | boolean | null> = {};
  const droppedKeys: string[] = [];

  for (const [key, value] of Object.entries(metadata)) {
    if (FORBIDDEN_METADATA_KEY_PATTERN.test(key)) {
      droppedKeys.push(key);
      continue;
    }
    const sanitized = sanitizeMetadataScalar(value);
    if (sanitized === undefined) {
      droppedKeys.push(key);
      continue;
    }
    result[key] = sanitized;
  }

  if (JSON.stringify(result).length > MAX_METADATA_JSON_LENGTH) {
    return {
      metadata: { truncated: true, originalKeyCount: Object.keys(result).length },
      droppedKeys: [...droppedKeys, ...Object.keys(result)],
    };
  }

  return { metadata: result, droppedKeys };
}
