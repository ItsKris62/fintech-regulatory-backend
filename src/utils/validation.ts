import { z } from 'zod';
import { PAGINATION } from '@/config/constants';

/**
 * Email validation schema
 * Standard email format with Kenyan TLD support
 */
export const emailSchema = z
  .string()
  .email('Invalid email address')
  .toLowerCase()
  .trim()
  .max(255, 'Email too long');

/**
 * Kenyan phone number validation
 * Supports formats:
 * - +254712345678
 * - 0712345678
 * - 712345678
 */
export const phoneSchema = z
  .string()
  .trim()
  .regex(
    /^(\+?254|0)?([17]\d{8})$/,
    'Invalid Kenyan phone number. Use format: +254712345678 or 0712345678'
  )
  .transform((val) => {
    // Normalize to +254 format
    const cleaned = val.replace(/\D/g, ''); // Remove non-digits

    if (cleaned.startsWith('254')) {
      return `+${cleaned}`;
    }

    if (cleaned.startsWith('0')) {
      return `+254${cleaned.substring(1)}`;
    }

    return `+254${cleaned}`;
  });

/**
 * Password validation schema
 * Requirements:
 * - Minimum 8 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one number
 * - Optional special characters
 */
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password too long')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number');

/**
 * Strong password schema (optional special characters)
 */
export const strongPasswordSchema = passwordSchema.regex(
  /[!@#$%^&*(),.?":{}|<>]/,
  'Password must contain at least one special character'
);

/**
 * URL validation schema
 */
export const urlSchema = z.string().url('Invalid URL');

/**
 * UUID validation schema
 */
export const uuidSchema = z.string().uuid('Invalid UUID');

/**
 * Date validation schema
 * Accepts ISO date string
 */
export const dateSchema = z.string().datetime('Invalid date format. Use ISO 8601');

/**
 * Date range validation schema
 */
export const dateRangeSchema = z.object({
  from: dateSchema,
  to: dateSchema,
}).refine((data) => new Date(data.from) <= new Date(data.to), {
  message: 'Start date must be before or equal to end date',
  path: ['from'],
});

/**
 * Pagination schema
 * Standard pagination with page and limit
 */
export const paginationSchema = z.object({
  page: z.number().int().min(1).default(PAGINATION.DEFAULT_PAGE),
  limit: z
    .number()
    .int()
    .min(1)
    .max(PAGINATION.MAX_LIMIT)
    .default(PAGINATION.DEFAULT_LIMIT),
});

/**
 * Cursor-based pagination schema
 * For large datasets
 */
export const cursorPaginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(PAGINATION.MAX_LIMIT)
    .default(PAGINATION.DEFAULT_LIMIT),
});

/**
 * Sort order schema
 */
export const sortOrderSchema = z.enum(['asc', 'desc']).default('desc');

/**
 * Search schema
 * For search queries with filters
 */
export const searchSchema = z.object({
  query: z.string().min(1).max(500).optional(),
  filters: z.record(z.string(), z.any()).optional(),
  sort: z
    .object({
      field: z.string(),
      order: sortOrderSchema,
    })
    .optional(),
  ...paginationSchema.shape,
});

/**
 * Kenyan national ID validation
 * Format: 12345678 (8 digits)
 */
export const nationalIdSchema = z
  .string()
  .regex(/^\d{8}$/, 'Invalid national ID. Must be 8 digits');

/**
 * Kenyan KRA PIN validation
 * Format: A123456789Z (letter + 9 digits + letter)
 */
export const kraPinSchema = z
  .string()
  .toUpperCase()
  .regex(
    /^[A-Z]\d{9}[A-Z]$/,
    'Invalid KRA PIN. Format: A123456789Z (letter + 9 digits + letter)'
  );

/**
 * Currency amount validation (Kenyan Shillings)
 * Positive number with up to 2 decimal places
 */
export const currencySchema = z
  .number()
  .positive('Amount must be positive')
  .multipleOf(0.01, 'Amount can have at most 2 decimal places')
  .max(999999999.99, 'Amount too large');

/**
 * Percentage validation
 * 0-100 inclusive
 */
export const percentageSchema = z.number().min(0).max(100);

/**
 * File upload validation schema
 */
export const fileUploadSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string(),
  size: z.number().positive(),
  data: z.instanceof(Buffer).optional(),
});

/**
 * Coordinate validation (for location data)
 */
export const coordinateSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

/**
 * MongoDB ObjectId validation (if needed)
 */
export const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid ObjectId');

/**
 * Slug validation (for URLs)
 * Lowercase alphanumeric with hyphens
 */
export const slugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid slug format. Use lowercase alphanumeric with hyphens');

/**
 * Color hex code validation
 */
export const hexColorSchema = z
  .string()
  .regex(/^#[0-9A-F]{6}$/i, 'Invalid hex color. Use format: #RRGGBB');

/**
 * JSON string validation
 * Validates that string is valid JSON
 */
export const jsonStringSchema = z.string().refine(
  (val) => {
    try {
      JSON.parse(val);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Invalid JSON string' }
);

/**
 * IP address validation (IPv4 and IPv6)
 */
export const ipAddressSchema = z.string().regex(
  /^(\d{1,3}\.){3}\d{1,3}$|^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/,
  'Invalid IP address'
);

/**
 * Kenyan business registration number validation
 * Format varies, but typically alphanumeric
 */
export const businessRegSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[A-Z0-9/-]+$/, 'Invalid business registration number');

/**
 * Validate Kenyan M-PESA phone number
 * Must be Safaricom number starting with 7
 */
export const mpesaPhoneSchema = z
  .string()
  .trim()
  .regex(
    /^(\+?254|0)?(7\d{8})$/,
    'Invalid M-PESA number. Must be a Safaricom number starting with 7'
  )
  .transform((val) => {
    const cleaned = val.replace(/\D/g, '');

    if (cleaned.startsWith('254')) {
      return `254${cleaned.substring(3)}`;
    }

    if (cleaned.startsWith('0')) {
      return `254${cleaned.substring(1)}`;
    }

    return `254${cleaned}`;
  });

/**
 * Helper: Create enum schema with custom error message
 */
export function createEnumSchema<T extends readonly string[]>(
  values: T,
  errorMessage?: string
) {
  return z.enum(values as any, {
    error: errorMessage || `Must be one of: ${values.join(', ')}`,
  });
}

/**
 * Helper: Create optional nullable schema
 */
export function nullable<T extends z.ZodTypeAny>(schema: T) {
  return schema.nullable().optional();
}

/**
 * Helper: Create array schema with min/max length
 */
export function arraySchema<T extends z.ZodTypeAny>(
  itemSchema: T,
  minLength?: number,
  maxLength?: number
) {
  let schema = z.array(itemSchema);

  if (minLength !== undefined) {
    schema = schema.min(minLength, `Array must have at least ${minLength} items`);
  }

  if (maxLength !== undefined) {
    schema = schema.max(maxLength, `Array cannot exceed ${maxLength} items`);
  }

  return schema;
}

/**
 * Helper: Validate and parse with Zod schema
 * Throws ValidationError if validation fails
 */
export async function validateInput<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown
): Promise<z.infer<T>> {
  try {
    return await schema.parseAsync(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      // Convert Zod error to ValidationError
      const { ValidationError } = await import('./error');
      throw ValidationError.fromZod(error);
    }
    throw error;
  }
}

/**
 * Helper: Safe parse (returns result instead of throwing)
 */
export function safeValidate<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown
): { success: true; data: z.infer<T> } | { success: false; error: z.ZodError } {
  const result = schema.safeParse(data);

  if (result.success) {
    return { success: true, data: result.data };
  }

  return { success: false, error: result.error };
}

/**
 * Helper: Check if value matches schema
 */
export function isValid<T extends z.ZodTypeAny>(schema: T, data: unknown): boolean {
  return schema.safeParse(data).success;
}

/**
 * Sanitize input string
 * Remove HTML tags and dangerous characters
 */
export function sanitizeString(input: string): string {
  return input
    .replace(/<[^>]*>/g, '') // Remove HTML tags
    .replace(/[<>\"]/g, '') // Remove dangerous characters
    .trim();
}

/**
 * Sanitize object recursively
 * Apply sanitizeString to all string values
 */
export function sanitizeObject<T extends Record<string, any>>(obj: T): T {
  const sanitized = { ...obj };

  for (const key in sanitized) {
    const value = sanitized[key];

    if (typeof value === 'string') {
      sanitized[key] = sanitizeString(value) as any;
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      sanitized[key] = sanitizeObject(value);
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map((item: unknown) =>
        typeof item === 'string' ? sanitizeString(item) : item
      ) as any;
    }
  }

  return sanitized;
}

/**
 * Export common type helpers
 */
export type InferInput<T extends z.ZodTypeAny> = z.input<T>;
export type InferOutput<T extends z.ZodTypeAny> = z.output<T>;