import { createHash } from 'node:crypto';
import { RAW_CONTENT_MAX_CHARS } from './types';

export function stableContentHash(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function sanitizeRawContent(input: string | null | undefined, maxChars = RAW_CONTENT_MAX_CHARS): string | null {
  if (!input) return null;
  const withoutScripts = input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();

  if (!withoutScripts) return null;
  return withoutScripts.slice(0, maxChars);
}

export function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced?.[1] ?? text;
  const firstObject = candidate.indexOf('{');
  const lastObject = candidate.lastIndexOf('}');
  const firstArray = candidate.indexOf('[');
  const lastArray = candidate.lastIndexOf(']');

  if (firstArray >= 0 && (firstObject < 0 || firstArray < firstObject) && lastArray > firstArray) {
    return JSON.parse(candidate.slice(firstArray, lastArray + 1)) as unknown;
  }

  if (firstObject >= 0 && lastObject > firstObject) {
    return JSON.parse(candidate.slice(firstObject, lastObject + 1)) as unknown;
  }

  return JSON.parse(candidate) as unknown;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

export function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function asNullableInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}