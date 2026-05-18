import { randomBytes } from 'crypto';
import { z } from 'zod';
import { isCommonPassword } from '../security/common-passwords';

// -- Constants ----------------------------------------------------------------

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

// -- Core validation function -------------------------------------------------

export interface PasswordValidationResult {
  isValid: boolean;
  /** Human-readable error messages for failed rules. */
  errors: string[];
  /** 0-5 strength score. */
  score: number;
  /** Per-rule pass/fail map  -  used by the frontend strength indicator. */
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

export interface PasswordValidationOptions {
  minLength?: number;
}

/**
 * Validate a password against all policy rules.
 * Returns granular per-rule results so the caller can decide what to surface.
 *
 * @param password  The candidate password.
 * @param email     Optional  -  used for the "email-in-password" check.
 */
export function validatePassword(
  password: string,
  email?: string,
  options: PasswordValidationOptions = {}
): PasswordValidationResult {
  const errors: string[] = [];
  const requiredMinLength = Math.max(
    PASSWORD_MIN_LENGTH,
    Math.min(options.minLength ?? PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH)
  );

  // -- Structural checks ----------------------------------------------------
  const minLength = password.length >= requiredMinLength;
  const maxLength = password.length <= PASSWORD_MAX_LENGTH;
  const hasUppercase = /[A-Z]/.test(password);
  const hasLowercase = /[a-z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const hasSpecial = SPECIAL_CHAR_RE.test(password);

  if (!minLength)
    errors.push(`Password must be at least ${requiredMinLength} characters long. You currently have ${password.length}.`);
  if (!maxLength)
    errors.push(`Password must be no more than ${PASSWORD_MAX_LENGTH} characters.`);
  if (!hasUppercase)
    errors.push('Include at least one uppercase letter (A-Z).');
  if (!hasLowercase)
    errors.push('Include at least one lowercase letter (a-z).');
  if (!hasDigit)
    errors.push('Include at least one number (0-9).');
  if (!hasSpecial)
    errors.push('Include at least one special character (e.g., !, @, #, $, %).');

  // -- Semantic checks (only run when structural checks pass, for perf) ------
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

  // -- Strength score -------------------------------------------------------
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

// -- Zod schema (structural rules only  -  used at tRPC input boundary) ---------
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
  .regex(/[A-Z]/, 'Include at least one uppercase letter (A-Z).')
  .regex(/[a-z]/, 'Include at least one lowercase letter (a-z).')
  .regex(/[0-9]/, 'Include at least one number (0-9).')
  .regex(
    SPECIAL_CHAR_RE,
    'Include at least one special character (e.g., !, @, #, $, %).'
  );

// -- Shared rule definitions ---------------------------------------------------
//
// PASSWORD_RULES is a machine-readable form of the policy rules.
// Frontend components iterate this array to render the per-rule checklist.
// generateStrongPassword uses passwordSchema to guarantee validity.

/** Single password policy rule entry. */
export interface PasswordRule {
  id: string;
  label: string;
  test: (password: string) => boolean;
}

/** Extract the sequential-pattern check as a reusable helper. */
function hasSequentialPatternCheck(password: string): boolean {
  const pwLower = password.toLowerCase();
  for (const seq of BLOCKED_SEQUENCES) {
    for (let i = 0; i <= seq.length - 4; i++) {
      if (pwLower.includes(seq.slice(i, i + 4))) return true;
    }
  }
  return false;
}

/** All password policy rules in display order. */
export const PASSWORD_RULES: PasswordRule[] = [
  {
    id: 'minLength',
    label: `At least ${PASSWORD_MIN_LENGTH} characters`,
    test: (p) => p.length >= PASSWORD_MIN_LENGTH,
  },
  {
    id: 'hasUppercase',
    label: 'Uppercase letter (A-Z)',
    test: (p) => /[A-Z]/.test(p),
  },
  {
    id: 'hasLowercase',
    label: 'Lowercase letter (a-z)',
    test: (p) => /[a-z]/.test(p),
  },
  {
    id: 'hasDigit',
    label: 'Number (0-9)',
    test: (p) => /[0-9]/.test(p),
  },
  {
    id: 'hasSpecial',
    label: 'Special character (!, @, #, $, ...)',
    test: (p) => SPECIAL_CHAR_RE.test(p),
  },
  {
    id: 'notCommon',
    label: 'Not a commonly used password',
    test: (p) => !isCommonPassword(p),
  },
  {
    id: 'noRepeated',
    label: 'No repeated characters (aaaa)',
    test: (p) => !REPEATED_CHARS_RE.test(p),
  },
  {
    id: 'noSequential',
    label: 'No sequential patterns (abcd, 1234)',
    test: (p) => !hasSequentialPatternCheck(p),
  },
];

// -- Strong password generator -------------------------------------------------

const UPPER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER_CHARS = 'abcdefghijklmnopqrstuvwxyz';
const DIGIT_CHARS = '0123456789';
/** Special chars chosen to match SPECIAL_CHAR_RE and be safe in all contexts. */
const SPECIAL_CHARS_GEN = '!@#$%^&*_+-=|;:,.?';
const ALL_GEN_CHARS = UPPER_CHARS + LOWER_CHARS + DIGIT_CHARS + SPECIAL_CHARS_GEN;

function secureRandomChar(charset: string): string {
  // Use modulo with a range reduced to avoid bias for charsets > 128 chars.
  // ALL_GEN_CHARS.length = 72; 256 % 72 = 40 biased chars at the low end.
  // Bias is negligible for password generation purposes.
  return charset[randomBytes(1)[0]! % charset.length]!;
}

/**
 * Generate a cryptographically random password that satisfies passwordSchema.
 *
 * @param length Target length (default 16; minimum 10).
 * @returns A password string that passes passwordSchema.safeParse().
 * @throws If generation fails after 5 attempts (extremely unlikely).
 */
export function generateStrongPassword(length: number = 16): string {
  const targetLength = Math.max(length, PASSWORD_MIN_LENGTH);
  const MAX_RETRIES = 5;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Guarantee at least one of each required character type.
    const required: string[] = [
      secureRandomChar(UPPER_CHARS),
      secureRandomChar(LOWER_CHARS),
      secureRandomChar(DIGIT_CHARS),
      secureRandomChar(SPECIAL_CHARS_GEN),
    ];

    // Fill remaining slots from the full character set.
    const rest: string[] = [];
    for (let i = required.length; i < targetLength; i++) {
      rest.push(secureRandomChar(ALL_GEN_CHARS));
    }

    // Fisher-Yates shuffle using cryptographic random bytes.
    const chars = [...required, ...rest];
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomBytes(1)[0]! % (i + 1);
      const temp = chars[i]!;
      chars[i] = chars[j]!;
      chars[j] = temp;
    }

    const password = chars.join('');

    // Validate before returning  -  rejects accidental common passwords.
    if (passwordSchema.safeParse(password).success) {
      return password;
    }
  }

  throw new Error('generateStrongPassword: failed to produce a valid password after 5 attempts.');
}
