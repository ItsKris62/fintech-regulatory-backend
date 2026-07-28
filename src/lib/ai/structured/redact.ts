import type { z } from 'zod';

const MAX_CORRECTION_ISSUES = 10;

// Lightweight redaction for text that will be re-sent to a model inside a
// correction prompt. Not the full W-SHARED-ERR secret-pattern list (that's a
// backend-operational-log concern) — this only needs to stop an accidental
// URL or credential-shaped string inside a Zod issue message (which can
// itself echo fragments of source/user content) from round-tripping back
// into a second prompt.
const URL_PATTERN = /https?:\/\/\S+/gi;
const SECRET_LIKE_PATTERN = /\b(?:sb_agent_|sk-|Bearer\s+)[A-Za-z0-9_\-.]{8,}\b/gi;

export function redactForPrompt(text: string): string {
  return text.replace(URL_PATTERN, '[REDACTED_URL]').replace(SECRET_LIKE_PATTERN, '[REDACTED_SECRET]');
}

export interface CorrectionIssueSummary {
  path: string;
  message: string;
}

/**
 * Reduces a ZodError's issues to a small, redacted, prompt-safe summary — at
 * most 10 items, {path, message} only. Deliberately drops `received`/`expected`
 * raw-value echoes, which could otherwise round-trip attacker-controlled
 * source text back into a second prompt.
 */
export function summarizeZodIssuesForCorrection(error: z.ZodError): CorrectionIssueSummary[] {
  return error.issues.slice(0, MAX_CORRECTION_ISSUES).map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: redactForPrompt(issue.message),
  }));
}
