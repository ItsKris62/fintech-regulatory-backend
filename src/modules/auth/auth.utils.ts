/**
 * Auth Module Utilities
 * Helper functions for authentication operations
 */

import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { z } from 'zod';
import type {
  SafeUser,
  SessionData,
} from './auth.types';
import { AUTH_CONSTANTS } from './auth.types';

const scryptAsync = promisify(scrypt);

// ============================================================================
// Password Utilities
// ============================================================================

/**
 * Hash a password using scrypt
 * Returns format: salt:hash
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(32).toString('hex');
  const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${derivedKey.toString('hex')}`;
}

/**
 * Verify a password against a stored hash
 */
export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  try {
    const [salt, hash] = storedHash.split(':');
    if (!salt || !hash) {
      return false;
    }
    
    const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
    const storedBuffer = Buffer.from(hash, 'hex');
    
    return timingSafeEqual(derivedKey, storedBuffer);
  } catch {
    return false;
  }
}

/**
 * Check if password was recently used
 */
export async function isPasswordRecentlyUsed(
  password: string,
  passwordHistory: string[]
): Promise<boolean> {
  for (const historicHash of passwordHistory) {
    if (await verifyPassword(password, historicHash)) {
      return true;
    }
  }
  return false;
}

// ============================================================================
// Token Generation
// ============================================================================

/**
 * Generate a random token (for reset tokens, verification tokens, etc.)
 */
export function generateToken(length: number = 32): string {
  return randomBytes(length).toString('hex');
}

/**
 * Generate a session ID
 */
export function generateSessionId(): string {
  return `sess_${randomBytes(24).toString('hex')}`;
}

/**
 * Generate a refresh token ID
 */
export function generateRefreshTokenId(): string {
  return `rt_${randomBytes(32).toString('hex')}`;
}

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * Email validation schema
 */
export const emailSchema = z
  .string()
  .email('Invalid email format')
  .min(5, 'Email too short')
  .max(255, 'Email too long')
  .toLowerCase()
  .trim();

/**
 * Password validation schema with strength requirements
 * - Minimum 8 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one number
 * - At least one special character
 */
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password does not meet complexity requirements')
  .regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/,
    'Password does not meet complexity requirements'
  );

/**
 * Validate password strength
 */
export function validatePasswordStrength(password: string): {
  isValid: boolean;
  errors: string[];
  score: number;
} {
  const errors: string[] = [];
  let score = 0;
  
  if (password.length >= 8) score += 1;
  else errors.push('Password must be at least 8 characters');
  
  if (password.length >= 12) score += 1;
  if (password.length >= 16) score += 1;
  
  if (/[a-z]/.test(password)) score += 1;
  else errors.push('Password must contain a lowercase letter');
  
  if (/[A-Z]/.test(password)) score += 1;
  else errors.push('Password must contain an uppercase letter');
  
  if (/\d/.test(password)) score += 1;
  else errors.push('Password must contain a number');
  
  if (/[@$!%*?&]/.test(password)) score += 1;
  else errors.push('Password must contain a special character (@$!%*?&)');
  
  // Bonus for variety
  if (/[^A-Za-z0-9@$!%*?&]/.test(password)) score += 1;
  
  return {
    isValid: errors.length === 0,
    errors,
    score: Math.min(score, 10),
  };
}

// ============================================================================
// Session Utilities
// ============================================================================

/**
 * Create session data object
 */
export function createSessionData(
  user: SafeUser,
  options?: { userAgent?: string; ipAddress?: string }
): SessionData {
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + AUTH_CONSTANTS.SESSION_EXPIRY * 1000
  );
  
  return {
    userId: user.id,
    email: user.email,
    role: user.role,
    organizationId: user.organizationId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    userAgent: options?.userAgent,
    ipAddress: options?.ipAddress,
  };
}

/**
 * Check if session is expired
 */
export function isSessionExpired(session: SessionData): boolean {
  return new Date(session.expiresAt) < new Date();
}

// ============================================================================
// User Utilities
// ============================================================================

/**
 * Strip sensitive fields from user object
 */
export function toSafeUser(user: {
  id: string;
  email: string;
  fullName?: string;
  name?: string;
  role: string;
  organizationId: string | null;
  emailVerified: boolean;
  phone: string | null;
  createdAt: Date;
  updatedAt: Date;
  password?: string | null;
  [key: string]: any;
}): SafeUser {
  return {
    id: user.id,
    email: user.email,
    name: user.fullName ?? user.name ?? '',
    role: user.role as SafeUser['role'],
    organizationId: user.organizationId,
    emailVerified: user.emailVerified,
    phone: user.phone,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

// ============================================================================
// Rate Limiting Utilities
// ============================================================================

/**
 * Calculate remaining lockout time in seconds
 */
export function calculateLockoutRemaining(lockedUntil: string): number {
  const lockoutEnd = new Date(lockedUntil);
  const now = new Date();
  const remaining = Math.ceil((lockoutEnd.getTime() - now.getTime()) / 1000);
  return Math.max(0, remaining);
}

/**
 * Format lockout message
 */
export function formatLockoutMessage(remainingSeconds: number): string {
  const minutes = Math.ceil(remainingSeconds / 60);
  if (minutes === 1) {
    return 'Account locked. Please try again in 1 minute.';
  }
  return `Account locked. Please try again in ${minutes} minutes.`;
}

// ============================================================================
// Email Utilities
// ============================================================================

/**
 * Generate password reset email content
 */
export function generatePasswordResetEmail(
  name: string,
  resetUrl: string,
  expiresIn: string = '1 hour'
): { subject: string; text: string; html: string } {
  return {
    subject: 'Reset Your SheriaBot Password',
    text: `
Hi ${name},

You requested to reset your password. Click the link below to set a new password:

${resetUrl}

This link will expire in ${expiresIn}.

If you didn't request this, please ignore this email or contact support if you have concerns.

Best regards,
The SheriaBot Team
    `.trim(),
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <h2 style="color: #2563eb;">Reset Your Password</h2>
    <p>Hi ${name},</p>
    <p>You requested to reset your password. Click the button below to set a new password:</p>
    <p style="text-align: center; margin: 30px 0;">
      <a href="${resetUrl}" 
         style="background-color: #2563eb; color: white; padding: 12px 24px; 
                text-decoration: none; border-radius: 6px; display: inline-block;">
        Reset Password
      </a>
    </p>
    <p style="color: #666; font-size: 14px;">
      This link will expire in ${expiresIn}.
    </p>
    <p style="color: #666; font-size: 14px;">
      If you didn't request this, please ignore this email or contact support if you have concerns.
    </p>
    <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
    <p style="color: #999; font-size: 12px;">
      Best regards,<br>
      The SheriaBot Team
    </p>
  </div>
</body>
</html>
    `.trim(),
  };
}

/**
 * Generate welcome email content
 */
export function generateWelcomeEmail(
  name: string,
  verificationUrl: string
): { subject: string; text: string; html: string } {
  return {
    subject: 'Welcome to SheriaBot - Verify Your Email',
    text: `
Welcome to SheriaBot, ${name}!

Thank you for signing up. Please verify your email address by clicking the link below:

${verificationUrl}

This link will expire in 24 hours.

After verification, you'll have full access to:
- AI-powered policy generation
- Compliance query system
- Document management
- And much more!

If you have any questions, feel free to reach out to our support team.

Best regards,
The SheriaBot Team
    `.trim(),
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <h2 style="color: #2563eb;">Welcome to SheriaBot!</h2>
    <p>Hi ${name},</p>
    <p>Thank you for signing up. Please verify your email address to get started:</p>
    <p style="text-align: center; margin: 30px 0;">
      <a href="${verificationUrl}" 
         style="background-color: #2563eb; color: white; padding: 12px 24px; 
                text-decoration: none; border-radius: 6px; display: inline-block;">
        Verify Email
      </a>
    </p>
    <p style="color: #666; font-size: 14px;">
      This link will expire in 24 hours.
    </p>
    <h3 style="color: #333; margin-top: 30px;">After verification, you'll have access to:</h3>
    <ul style="color: #666;">
      <li>AI-powered policy generation</li>
      <li>Compliance query system</li>
      <li>Document management</li>
      <li>And much more!</li>
    </ul>
    <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
    <p style="color: #999; font-size: 12px;">
      Best regards,<br>
      The SheriaBot Team
    </p>
  </div>
</body>
</html>
    `.trim(),
  };
}