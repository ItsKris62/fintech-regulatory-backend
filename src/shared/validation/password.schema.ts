import { z } from 'zod';
import { isCommonPassword } from '../security/common-passwords';

// ── Constants ────────────────────────────────────────────────────────────────

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/** Special characters accepted as the "special char" requirement. */
const SPECIAL_CHAR_RE = /[!@#$%^&*()\-_+=[\]{}|;:'",.<>?/~`\\]/;

/** Regex for 4+ repeated identical characters: aaaa, 1111, etc. */
const REPEATED_CHARS_RE = /(.)\1{3,}/;

/**
 * Keyboard and alphabet sequences to reject (4+ consecutive chars).
 * Lower-cased; check is case-insensitive.
 */
const BLOCKED_SEQUENCES = [
  'abcdefghijklmnopqrstuvwxyz',
  'zyxwvutsrqponmlkjihgfedcba',
  '0123456789',
  '9876543210',
  'qwertyuiop',
  'poiuytrewq',
  'asdfghjkl',
  'lkjhgfdsa',
  'zxcvbnm',
  'mnbvcxz',
];

// ── Core validation function ─────────────────────────────────────────────────

export interface PasswordValidationResult {
  isValid: boolean;
  /** Human-readable error messages for failed rules. */
  errors: string[];
  /** 0–5 strength score. */
  score: number;
  /** Per-rule pass/fail map — used by the frontend strength indicator. */
  rules: {
    minLength: boolean;
    maxLength: boolean;
    hasUppercase: boolean;
    hasLowercase: boolean;
    hasDigit: boolean;
    hasSpecial: boolean;
    notCommon: boolean;
    notEmail: boolean;
    noRepeated: boolean;
    noSequential: boolean;
  };
}

/**
 * Validate a password against all policy rules.
 * Returns granular per-rule results so the caller can decide what to surface.
 *
 * @param password  The candidate password.
 * @param email     Optional — used for the "email-in-password" check.
 */
export function validatePassword(
  password: string,
  email?: string
): PasswordValidationResult {
  const errors: string[] = [];

  // ── Structural checks ────────────────────────────────────────────────────
  const minLength = password.length >= PASSWORD_MIN_LENGTH;
  const maxLength = password.length <= PASSWORD_MAX_LENGTH;
  const hasUppercase = /[A-Z]/.test(password);
  const hasLowercase = /[a-z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const hasSpecial = SPECIAL_CHAR_RE.test(password);

  if (!minLength)
    errors.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters long. You currently have ${password.length}.`);
  if (!maxLength)
    errors.push(`Password must be no more than ${PASSWORD_MAX_LENGTH} characters.`);
  if (!hasUppercase)
    errors.push('Include at least one uppercase letter (A–Z).');
  if (!hasLowercase)
    errors.push('Include at least one lowercase letter (a–z).');
  if (!hasDigit)
    errors.push('Include at least one number (0–9).');
  if (!hasSpecial)
    errors.push('Include at least one special character (e.g., !, @, #, $, %).');

  // ── Semantic checks (only run when structural checks pass, for perf) ──────
  const structuralPassed = minLength && maxLength && hasUppercase && hasLowercase && hasDigit && hasSpecial;

  const notCommon = structuralPassed ? !isCommonPassword(password) : true;
  if (structuralPassed && !notCommon)
    errors.push('This password is too commonly used and could be easily guessed. Try combining unrelated words or a passphrase.');

  // Email-in-password check
  let notEmail = true;
  if (email) {
    const emailLower = email.toLowerCase();
    const localPart = emailLower.split('@')[0] ?? '';
    const pwLower = password.toLowerCase();
    if (pwLower.includes(emailLower) || (localPart.length >= 3 && pwLower.includes(localPart))) {
      notEmail = false;
      errors.push('Password must not contain your email address or username.');
    }
  }

  // Repeated characters: aaaa, 1111, etc.
  const noRepeated = !REPEATED_CHARS_RE.test(password);
  if (!noRepeated)
    errors.push('Avoid sequences of 4 or more repeated characters (e.g., "aaaa", "1111").');

  // Sequential keyboard/alphabet patterns
  const pwLower = password.toLowerCase();
  let foundSequential = false;
  for (const seq of BLOCKED_SEQUENCES) {
    for (let i = 0; i <= seq.length - 4; i++) {
      if (pwLower.includes(seq.slice(i, i + 4))) {
        foundSequential = true;
        break;
      }
    }
    if (foundSequential) break;
  }
  const noSequential = !foundSequential;
  if (foundSequential)
    errors.push('Avoid keyboard patterns or sequential characters (e.g., "abcd", "1234", "qwer").');

  // ── Strength score ───────────────────────────────────────────────────────
  let score = 0;
  if (minLength) score++;
  if (password.length >= 14) score++;          // bonus for length
  if (hasUppercase && hasLowercase) score++;
  if (hasDigit) score++;
  if (hasSpecial) score++;
  if (notCommon && noRepeated && noSequential) score = Math.min(score + 1, 5);
  score = Math.min(score, 5);

  return {
    isValid: errors.length === 0,
    errors,
    score,
    rules: {
      minLength,
      maxLength,
      hasUppercase,
      hasLowercase,
      hasDigit,
      hasSpecial,
      notCommon,
      notEmail,
      noRepeated,
      noSequential,
    },
  };
}

// ── Zod schema (structural rules only — used at tRPC input boundary) ─────────
//
// Uses chained .regex() calls so Zod accumulates ALL failed checks at once.
// Each rule has a specific, actionable message.
// Semantic checks (common password, email-in-password, sequential) are handled
// explicitly in the router via validatePassword() above.

export const passwordSchema = z
  .string()
  .min(
    PASSWORD_MIN_LENGTH,
    `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`
  )
  .max(
    PASSWORD_MAX_LENGTH,
    `Password must be no more than ${PASSWORD_MAX_LENGTH} characters.`
  )
  .regex(/[A-Z]/, 'Include at least one uppercase letter (A–Z).')
  .regex(/[a-z]/, 'Include at least one lowercase letter (a–z).')
  .regex(/[0-9]/, 'Include at least one number (0–9).')
  .regex(
    SPECIAL_CHAR_RE,
    'Include at least one special character (e.g., !, @, #, $, %).'
  );
