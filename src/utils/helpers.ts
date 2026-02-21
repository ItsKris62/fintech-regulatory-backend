import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import { CURRENCY } from '@/config/constants';

/**
 * Password hashing and verification
 */

/**
 * Hash password using bcrypt
 * @param password Plain text password
 * @returns Hashed password
 */
export async function hashPassword(password: string): Promise<string> {
  const saltRounds = 10;
  return await bcrypt.hash(password, saltRounds);
}

/**
 * Verify password against hash
 * @param password Plain text password
 * @param hashedPassword Hashed password from database
 * @returns true if password matches
 */
export async function verifyPassword(
  password: string,
  hashedPassword: string
): Promise<boolean> {
  return await bcrypt.compare(password, hashedPassword);
}

/**
 * Token generation
 */

/**
 * Generate secure random token
 * @param length Token length in bytes (default: 32)
 * @returns Hex string token
 */
export function generateToken(length: number = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Generate short alphanumeric code (for verification, etc.)
 * @param length Code length (default: 6)
 * @returns Alphanumeric code
 */
export function generateCode(length: number = 6): string {
  const characters = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';

  for (let i = 0; i < length; i++) {
    code += characters.charAt(Math.floor(Math.random() * characters.length));
  }

  return code;
}

/**
 * Generate unique ID using nanoid
 * @param length ID length (default: 21)
 * @returns Unique ID
 */
export function generateId(length: number = 21): string {
  return nanoid(length);
}

/**
 * Generate short ID (for public IDs, slugs)
 * @param length ID length (default: 8)
 * @returns Short unique ID
 */
export function generateShortId(length: number = 8): string {
  return nanoid(length);
}

/**
 * String manipulation
 */

/**
 * Slugify text for URLs
 * @param text Text to slugify
 * @returns URL-safe slug
 *
 * @example
 * slugify("Data Protection Act 2019") // "data-protection-act-2019"
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '') // Remove special characters
    .replace(/[\s_-]+/g, '-') // Replace spaces and underscores with hyphens
    .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
}

/**
 * Truncate text to specified length
 * @param text Text to truncate
 * @param maxLength Maximum length
 * @param suffix Suffix to add if truncated (default: '...')
 * @returns Truncated text
 */
export function truncate(text: string, maxLength: number, suffix: string = '...'): string {
  if (text.length <= maxLength) {
    return text;
  }

  return text.substring(0, maxLength - suffix.length) + suffix;
}

/**
 * Capitalize first letter of string
 * @param text Text to capitalize
 * @returns Capitalized text
 */
export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

/**
 * Capitalize first letter of each word
 * @param text Text to title case
 * @returns Title cased text
 */
export function titleCase(text: string): string {
  return text
    .toLowerCase()
    .split(' ')
    .map((word) => capitalize(word))
    .join(' ');
}

/**
 * Format Kenyan phone number for display
 * @param phone Phone number (any format)
 * @returns Formatted phone (e.g., "+254 712 345 678")
 */
export function formatPhone(phone: string): string {
  // Remove all non-digits
  const cleaned = phone.replace(/\D/g, '');

  // Format as +254 712 345 678
  if (cleaned.startsWith('254')) {
    const number = cleaned.substring(3);
    return `+254 ${number.substring(0, 3)} ${number.substring(3, 6)} ${number.substring(6)}`;
  }

  return phone;
}

/**
 * Currency formatting
 */

/**
 * Format amount as Kenyan Shillings
 * @param amount Amount in KES
 * @param showSymbol Whether to show currency symbol
 * @returns Formatted currency string
 *
 * @example
 * formatCurrency(1234.56) // "KSh 1,234.56"
 * formatCurrency(1000, false) // "1,000.00"
 */
export function formatCurrency(amount: number, showSymbol: boolean = true): string {
  const formatted = amount.toLocaleString('en-KE', {
    minimumFractionDigits: CURRENCY.DECIMAL_PLACES,
    maximumFractionDigits: CURRENCY.DECIMAL_PLACES,
  });

  return showSymbol ? `${CURRENCY.SYMBOL} ${formatted}` : formatted;
}

/**
 * Parse currency string to number
 * @param currencyString Currency string (e.g., "KSh 1,234.56")
 * @returns Amount as number
 */
export function parseCurrency(currencyString: string): number {
  const cleaned = currencyString.replace(/[^\d.-]/g, '');
  return parseFloat(cleaned);
}

/**
 * Hashing and encoding
 */

/**
 * Calculate SHA-256 hash of string
 * Useful for cache keys, checksums
 * @param text Text to hash
 * @returns Hex hash string
 */
export function hashString(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Calculate MD5 hash (for quick checksums)
 * @param text Text to hash
 * @returns Hex hash string
 */
export function md5Hash(text: string): string {
  return crypto.createHash('md5').update(text).digest('hex');
}

/**
 * Base64 encode string
 * @param text Text to encode
 * @returns Base64 encoded string
 */
export function base64Encode(text: string): string {
  return Buffer.from(text).toString('base64');
}

/**
 * Base64 decode string
 * @param encoded Base64 encoded string
 * @returns Decoded string
 */
export function base64Decode(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf-8');
}

/**
 * URL-safe base64 encode
 * @param text Text to encode
 * @returns URL-safe base64 string
 */
export function base64UrlEncode(text: string): string {
  return base64Encode(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * URL-safe base64 decode
 * @param encoded URL-safe base64 string
 * @returns Decoded string
 */
export function base64UrlDecode(encoded: string): string {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  return base64Decode(base64);
}

/**
 * File handling
 */

/**
 * Generate unique filename with timestamp
 * @param originalName Original filename
 * @param preserveExtension Whether to keep original extension
 * @returns Unique filename
 *
 * @example
 * generateFilename("document.pdf") // "1704067200000-abc123.pdf"
 */
export function generateFilename(originalName: string, preserveExtension: boolean = true): string {
  const timestamp = Date.now();
  const random = generateShortId(8);

  if (preserveExtension) {
    const extension = originalName.substring(originalName.lastIndexOf('.'));
    return `${timestamp}-${random}${extension}`;
  }

  return `${timestamp}-${random}`;
}

/**
 * Get file extension from filename
 * @param filename Filename
 * @returns Extension with dot (e.g., ".pdf")
 */
export function getFileExtension(filename: string): string {
  return filename.substring(filename.lastIndexOf('.'));
}

/**
 * Get MIME type from file extension
 * @param extension File extension (with or without dot)
 * @returns MIME type
 */
export function getMimeType(extension: string): string {
  const ext = extension.startsWith('.') ? extension.substring(1) : extension;

  const mimeTypes: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    xml: 'application/xml',
    csv: 'text/csv',
  };

  return mimeTypes[ext.toLowerCase()] || 'application/octet-stream';
}

/**
 * Format file size for display
 * @param bytes File size in bytes
 * @param decimals Number of decimal places
 * @returns Formatted size (e.g., "1.5 MB")
 */
export function formatFileSize(bytes: number, decimals: number = 2): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

/**
 * Date and time
 */

/**
 * Calculate reading time from text
 * Assumes average reading speed of 200 words per minute
 * @param text Text content
 * @returns Reading time in minutes
 */
export function calculateReadingTime(text: string): number {
  const wordsPerMinute = 200;
  const wordCount = text.trim().split(/\s+/).length;
  return Math.ceil(wordCount / wordsPerMinute);
}

/**
 * Format duration in milliseconds to human-readable string
 * @param ms Duration in milliseconds
 * @returns Formatted duration (e.g., "2m 30s")
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }

  return `${seconds}s`;
}

/**
 * Check if date is in the past
 * @param date Date to check
 * @returns true if date is in the past
 */
export function isPast(date: Date | string): boolean {
  return new Date(date) < new Date();
}

/**
 * Check if date is in the future
 * @param date Date to check
 * @returns true if date is in the future
 */
export function isFuture(date: Date | string): boolean {
  return new Date(date) > new Date();
}

/**
 * Get date X days from now
 * @param days Number of days
 * @returns Future date
 */
export function addDays(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}

/**
 * Object manipulation
 */

/**
 * Deep clone object
 * @param obj Object to clone
 * @returns Cloned object
 */
export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Pick specific keys from object
 * @param obj Source object
 * @param keys Keys to pick
 * @returns New object with only specified keys
 */
export function pick<T extends Record<string, any>, K extends keyof T>(
  obj: T,
  keys: K[]
): Pick<T, K> {
  const result = {} as Pick<T, K>;

  for (const key of keys) {
    if (key in obj) {
      result[key] = obj[key];
    }
  }

  return result;
}

/**
 * Omit specific keys from object
 * @param obj Source object
 * @param keys Keys to omit
 * @returns New object without specified keys
 */
export function omit<T extends Record<string, any>, K extends keyof T>(
  obj: T,
  keys: K[]
): Omit<T, K> {
  const result = { ...obj };

  for (const key of keys) {
    delete result[key];
  }

  return result as Omit<T, K>;
}

/**
 * Check if object is empty
 * @param obj Object to check
 * @returns true if object has no keys
 */
export function isEmpty(obj: Record<string, any>): boolean {
  return Object.keys(obj).length === 0;
}

/**
 * Array utilities
 */

/**
 * Remove duplicates from array
 * @param arr Array with potential duplicates
 * @returns Array with unique values
 */
export function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/**
 * Chunk array into smaller arrays
 * @param arr Source array
 * @param size Chunk size
 * @returns Array of chunks
 */
export function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }

  return chunks;
}

/**
 * Shuffle array (Fisher-Yates algorithm)
 * @param arr Array to shuffle
 * @returns Shuffled array (new array)
 */
export function shuffle<T>(arr: T[]): T[] {
  const shuffled = [...arr];

  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return shuffled;
}

/**
 * Async utilities
 */

/**
 * Sleep for specified duration
 * @param ms Duration in milliseconds
 * @returns Promise that resolves after duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry async function with exponential backoff
 * @param fn Async function to retry
 * @param maxAttempts Maximum number of attempts
 * @param delay Initial delay in ms
 * @returns Result of function
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  delay: number = 1000
): Promise<T> {
  let lastError: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt < maxAttempts) {
        await sleep(delay * Math.pow(2, attempt - 1)); // Exponential backoff
      }
    }
  }

  throw lastError;
}

/**
 * Sanitization
 */

/**
 * Sanitize HTML by removing tags
 * @param html HTML string
 * @returns Plain text
 */
export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

/**
 * Sanitize filename (remove special characters)
 * @param filename Original filename
 * @returns Sanitized filename
 */
export function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9.-]/g, '_')
    .replace(/_{2,}/g, '_')
    .substring(0, 255);
}

/**
 * Mask sensitive data (for logging)
 * @param value Value to mask
 * @param visibleChars Number of visible characters at start/end
 * @returns Masked value
 *
 * @example
 * maskSensitive("1234567890", 2) // "12****90"
 */
export function maskSensitive(value: string, visibleChars: number = 4): string {
  if (value.length <= visibleChars * 2) {
    return '*'.repeat(value.length);
  }

  const start = value.substring(0, visibleChars);
  const end = value.substring(value.length - visibleChars);
  const masked = '*'.repeat(value.length - visibleChars * 2);

  return `${start}${masked}${end}`;
}