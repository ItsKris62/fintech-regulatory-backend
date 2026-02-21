import { ERROR_CODES, ERROR_MESSAGES } from '@/config/constants';

/**
 * Base application error class
 * All custom errors extend from this
 */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public metadata?: Record<string, any>
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Serialize error for API response
   */
  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.metadata && { details: this.metadata }),
      },
    };
  }
}

/**
 * 400 Bad Request
 * Client sent invalid data
 */
export class BadRequestError extends AppError {
  constructor(message: string = 'Bad Request', metadata?: Record<string, any>) {
    super(400, ERROR_CODES.INVALID_INPUT, message, metadata);
  }
}

/**
 * 401 Unauthorized
 * Authentication required or failed
 */
export class UnauthorizedError extends AppError {
  constructor(
    message: string = 'Unauthorized',
    code: string = ERROR_CODES.INVALID_TOKEN,
    metadata?: Record<string, any>
  ) {
    super(401, code, message, metadata);
  }
}

/**
 * 403 Forbidden
 * User authenticated but doesn't have permission
 */
export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden', metadata?: Record<string, any>) {
    super(403, ERROR_CODES.INSUFFICIENT_PERMISSIONS, message, metadata);
  }
}

/**
 * 404 Not Found
 * Resource not found
 */
export class NotFoundError extends AppError {
  constructor(resource: string = 'Resource', metadata?: Record<string, any>) {
    super(404, ERROR_CODES.RESOURCE_NOT_FOUND, `${resource} not found`, metadata);
  }
}

/**
 * 409 Conflict
 * Resource already exists or constraint violation
 */
export class ConflictError extends AppError {
  constructor(message: string = 'Resource already exists', metadata?: Record<string, any>) {
    super(409, ERROR_CODES.UNIQUE_VIOLATION, message, metadata);
  }
}

/**
 * 422 Validation Error
 * Request data failed validation
 */
export class ValidationError extends AppError {
  constructor(
    message: string = 'Validation failed',
    validationErrors?: Record<string, any>
  ) {
    super(422, ERROR_CODES.INVALID_INPUT, message, { validationErrors });
  }

  /**
   * Create from Zod validation error
   */
  static fromZod(zodError: any): ValidationError {
    const validationErrors: Record<string, string> = {};

    zodError.errors?.forEach((err: any) => {
      const path = err.path.join('.');
      validationErrors[path] = err.message;
    });

    return new ValidationError('Validation failed', validationErrors);
  }
}

/**
 * 429 Too Many Requests
 * Rate limit exceeded
 */
export class TooManyRequestsError extends AppError {
  constructor(
    message: string = 'Too many requests',
    retryAfter?: number,
    metadata?: Record<string, any>
  ) {
    super(
      429,
      ERROR_CODES.RATE_LIMIT_EXCEEDED,
      message,
      retryAfter ? { ...metadata, retryAfter } : metadata
    );
  }
}

/**
 * 500 Internal Server Error
 * Unexpected server error
 */
export class InternalServerError extends AppError {
  constructor(message: string = 'Internal server error', metadata?: Record<string, any>) {
    super(500, ERROR_CODES.INTERNAL_SERVER_ERROR, message, metadata);
  }
}

/**
 * 503 Service Unavailable
 * Service temporarily unavailable
 */
export class ServiceUnavailableError extends AppError {
  constructor(service: string = 'Service', metadata?: Record<string, any>) {
    super(503, ERROR_CODES.SERVICE_UNAVAILABLE, `${service} is temporarily unavailable`, metadata);
  }
}

/**
 * Authentication-specific errors
 */
export class InvalidCredentialsError extends UnauthorizedError {
  constructor() {
    super(ERROR_MESSAGES[ERROR_CODES.INVALID_CREDENTIALS], ERROR_CODES.INVALID_CREDENTIALS);
  }
}

export class EmailNotVerifiedError extends UnauthorizedError {
  constructor() {
    super(ERROR_MESSAGES[ERROR_CODES.EMAIL_NOT_VERIFIED], ERROR_CODES.EMAIL_NOT_VERIFIED);
  }
}

export class AccountSuspendedError extends ForbiddenError {
  constructor() {
    super(ERROR_MESSAGES[ERROR_CODES.ACCOUNT_SUSPENDED], {
      code: ERROR_CODES.ACCOUNT_SUSPENDED,
    });
  }
}

export class TokenExpiredError extends UnauthorizedError {
  constructor() {
    super(ERROR_MESSAGES[ERROR_CODES.TOKEN_EXPIRED], ERROR_CODES.TOKEN_EXPIRED);
  }
}

export class SessionNotFoundError extends UnauthorizedError {
  constructor() {
    super(ERROR_MESSAGES[ERROR_CODES.SESSION_NOT_FOUND], ERROR_CODES.SESSION_NOT_FOUND);
  }
}

export class EmailAlreadyExistsError extends ConflictError {
  constructor() {
    super(ERROR_MESSAGES[ERROR_CODES.EMAIL_ALREADY_EXISTS], {
      field: 'email',
      code: ERROR_CODES.EMAIL_ALREADY_EXISTS,
    });
  }
}

export class WeakPasswordError extends BadRequestError {
  constructor() {
    super(ERROR_MESSAGES[ERROR_CODES.WEAK_PASSWORD], {
      code: ERROR_CODES.WEAK_PASSWORD,
      requirements: {
        minLength: 8,
        requiresUppercase: true,
        requiresLowercase: true,
        requiresNumber: true,
      },
    });
  }
}

/**
 * Resource-specific errors
 */
export class UserNotFoundError extends NotFoundError {
  constructor(userId?: string) {
    super('User', { userId, code: ERROR_CODES.USER_NOT_FOUND });
  }
}

export class PolicyNotFoundError extends NotFoundError {
  constructor(policyId?: string) {
    super('Policy', { policyId, code: ERROR_CODES.POLICY_NOT_FOUND });
  }
}

export class DocumentNotFoundError extends NotFoundError {
  constructor(documentId?: string) {
    super('Document', { documentId, code: ERROR_CODES.DOCUMENT_NOT_FOUND });
  }
}

export class OrganizationNotFoundError extends NotFoundError {
  constructor(organizationId?: string) {
    super('Organization', { organizationId, code: ERROR_CODES.ORGANIZATION_NOT_FOUND });
  }
}

/**
 * File upload errors
 */
export class InvalidFileTypeError extends BadRequestError {
  constructor(allowedTypes: string[]) {
    super(ERROR_MESSAGES[ERROR_CODES.INVALID_FILE_TYPE], {
      code: ERROR_CODES.INVALID_FILE_TYPE,
      allowedTypes,
    });
  }
}

export class FileTooLargeError extends BadRequestError {
  constructor(maxSize: number, actualSize: number) {
    super(ERROR_MESSAGES[ERROR_CODES.FILE_TOO_LARGE], {
      code: ERROR_CODES.FILE_TOO_LARGE,
      maxSize,
      actualSize,
      maxSizeMB: Math.round(maxSize / (1024 * 1024)),
      actualSizeMB: Math.round(actualSize / (1024 * 1024)),
    });
  }
}

/**
 * AI/RAG errors
 */
export class AIServiceError extends InternalServerError {
  constructor(message: string = 'AI service error', metadata?: Record<string, any>) {
    super(message, { ...metadata, code: ERROR_CODES.AI_SERVICE_ERROR });
  }
}

export class PolicyGenerationError extends InternalServerError {
  constructor(message?: string, metadata?: Record<string, any>) {
    super(
      message || ERROR_MESSAGES[ERROR_CODES.POLICY_GENERATION_FAILED],
      { ...metadata, code: ERROR_CODES.POLICY_GENERATION_FAILED }
    );
  }
}

export class ComplianceQueryError extends InternalServerError {
  constructor(message?: string, metadata?: Record<string, any>) {
    super(
      message || ERROR_MESSAGES[ERROR_CODES.COMPLIANCE_QUERY_FAILED],
      { ...metadata, code: ERROR_CODES.COMPLIANCE_QUERY_FAILED }
    );
  }
}

export class VectorSearchError extends InternalServerError {
  constructor(message?: string, metadata?: Record<string, any>) {
    super(
      message || ERROR_MESSAGES[ERROR_CODES.VECTOR_SEARCH_FAILED],
      { ...metadata, code: ERROR_CODES.VECTOR_SEARCH_FAILED }
    );
  }
}

/**
 * Document processing errors
 */
export class DocumentUploadError extends InternalServerError {
  constructor(message?: string, metadata?: Record<string, any>) {
    super(
      message || ERROR_MESSAGES[ERROR_CODES.DOCUMENT_UPLOAD_FAILED],
      { ...metadata, code: ERROR_CODES.DOCUMENT_UPLOAD_FAILED }
    );
  }
}

export class DocumentParsingError extends InternalServerError {
  constructor(message?: string, metadata?: Record<string, any>) {
    super(
      message || ERROR_MESSAGES[ERROR_CODES.DOCUMENT_PARSING_FAILED],
      { ...metadata, code: ERROR_CODES.DOCUMENT_PARSING_FAILED }
    );
  }
}

export class DocumentIndexingError extends InternalServerError {
  constructor(message?: string, metadata?: Record<string, any>) {
    super(
      message || ERROR_MESSAGES[ERROR_CODES.DOCUMENT_INDEXING_FAILED],
      { ...metadata, code: ERROR_CODES.DOCUMENT_INDEXING_FAILED }
    );
  }
}

/**
 * External service errors
 */
export class EmailServiceError extends ServiceUnavailableError {
  constructor(message?: string) {
    super('Email service', {
      code: ERROR_CODES.EMAIL_SERVICE_ERROR,
      ...(message && { originalMessage: message }),
    });
  }
}

export class StorageServiceError extends ServiceUnavailableError {
  constructor(message?: string) {
    super('Storage service', {
      code: ERROR_CODES.STORAGE_SERVICE_ERROR,
      ...(message && { originalMessage: message }),
    });
  }
}

export class RedisError extends ServiceUnavailableError {
  constructor(message?: string) {
    super('Cache service', {
      code: ERROR_CODES.REDIS_ERROR,
      ...(message && { originalMessage: message }),
    });
  }
}

export class PineconeError extends ServiceUnavailableError {
  constructor(message?: string) {
    super('Vector database', {
      code: ERROR_CODES.PINECONE_ERROR,
      ...(message && { originalMessage: message }),
    });
  }
}

/**
 * Check if error is an AppError
 */
export function isAppError(error: any): error is AppError {
  return error instanceof AppError;
}

/**
 * Convert any error to AppError
 */
export function toAppError(error: any): AppError {
  if (isAppError(error)) {
    return error;
  }

  // Prisma errors
  if (error.code === 'P2002') {
    return new ConflictError('Resource already exists');
  }

  if (error.code === 'P2025') {
    return new NotFoundError();
  }

  // Zod validation errors
  if (error.name === 'ZodError') {
    return ValidationError.fromZod(error);
  }

  // Default to internal server error
  return new InternalServerError(error.message || 'An unexpected error occurred', {
    originalError: error.toString(),
  });
}