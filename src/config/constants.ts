/**
 * Application constants
 * Enums, regulatory data, error codes, and other constant values
 */

/**
 * User roles enum
 */
export enum UserRole {
  ADMIN = 'ADMIN',
  REGULATOR = 'REGULATOR',
  STARTUP = 'STARTUP',
  ENTERPRISE = 'ENTERPRISE',
}

/**
 * User status enum
 */
export enum UserStatus {
  PENDING_VERIFICATION = 'PENDING_VERIFICATION',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  DEACTIVATED = 'DEACTIVATED',
}

/**
 * Organization type enum
 */
export enum OrganizationType {
  GOVERNMENT = 'GOVERNMENT',
  REGULATOR = 'REGULATOR',
  STARTUP = 'STARTUP',
  ENTERPRISE = 'ENTERPRISE',
  NGO = 'NGO',
}

/**
 * Policy status enum
 */
export enum PolicyStatus {
  DRAFT = 'DRAFT',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  ARCHIVED = 'ARCHIVED',
}

/**
 * Policy urgency levels
 */
export enum PolicyUrgency {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

/**
 * Legal document status
 */
export enum DocumentStatus {
  UPLOADING = 'UPLOADING',
  PROCESSING = 'PROCESSING',
  INDEXED = 'INDEXED',
  FAILED = 'FAILED',
  ARCHIVED = 'ARCHIVED',
}

/**
 * Document type enum
 */
export enum DocumentType {
  ACT = 'ACT',
  REGULATION = 'REGULATION',
  GUIDELINE = 'GUIDELINE',
  POLICY = 'POLICY',
  DIRECTIVE = 'DIRECTIVE',
  CIRCULAR = 'CIRCULAR',
}

/**
 * Compliance query status
 */
export enum ComplianceQueryStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

/**
 * Checklist status
 */
export enum ChecklistStatus {
  NOT_STARTED = 'NOT_STARTED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  OVERDUE = 'OVERDUE',
}

/**
 * Notification types
 */
export enum NotificationType {
  POLICY_READY = 'POLICY_READY',
  POLICY_FAILED = 'POLICY_FAILED',
  COMMENT_ADDED = 'COMMENT_ADDED',
  COMMENT_REPLY = 'COMMENT_REPLY',
  COMPLIANCE_ALERT = 'COMPLIANCE_ALERT',
  DOCUMENT_INDEXED = 'DOCUMENT_INDEXED',
  SYSTEM_ALERT = 'SYSTEM_ALERT',
  SUBSCRIPTION_EXPIRING = 'SUBSCRIPTION_EXPIRING',
  PAYMENT_RECEIVED = 'PAYMENT_RECEIVED',
  ACCOUNT_SUSPENDED = 'ACCOUNT_SUSPENDED',
}

/**
 * Audit log actions
 */
export enum AuditAction {
  USER_CREATED = 'USER_CREATED',
  USER_UPDATED = 'USER_UPDATED',
  USER_DELETED = 'USER_DELETED',
  USER_LOGIN = 'USER_LOGIN',
  USER_LOGOUT = 'USER_LOGOUT',
  POLICY_GENERATED = 'POLICY_GENERATED',
  POLICY_UPDATED = 'POLICY_UPDATED',
  POLICY_DELETED = 'POLICY_DELETED',
  DOCUMENT_UPLOADED = 'DOCUMENT_UPLOADED',
  DOCUMENT_DELETED = 'DOCUMENT_DELETED',
  COMPLIANCE_QUERY = 'COMPLIANCE_QUERY',
  SETTINGS_CHANGED = 'SETTINGS_CHANGED',
  ROLE_CHANGED = 'ROLE_CHANGED',
}

/**
 * Citation confidence levels
 */
export enum CitationConfidence {
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
  UNVERIFIED = 'UNVERIFIED',
}

/**
 * Kenyan regulatory areas
 * Key compliance domains for fintech
 */
export const REGULATORY_AREAS = [
  'Data Protection',
  'Fintech & Digital Lending',
  'Anti-Money Laundering (AML)',
  'Know Your Customer (KYC)',
  'Consumer Protection',
  'Cybersecurity',
  'Payment Systems',
  'Banking & Financial Services',
  'Insurance',
  'Capital Markets',
  'Tax Compliance',
  'Employment & Labor',
  'Intellectual Property',
  'Competition & Antitrust',
  'Environmental Compliance',
] as const;

export type RegulatoryArea = (typeof REGULATORY_AREAS)[number];

/**
 * Kenyan legal acts and regulations
 * Key legislation for fintech compliance
 */
export const KENYAN_LEGAL_ACTS = [
  // Data Protection
  {
    name: 'Data Protection Act, 2019',
    shortName: 'DPA 2019',
    year: 2019,
    areas: ['Data Protection', 'Cybersecurity'],
    authority: 'Office of the Data Protection Commissioner',
  },
  {
    name: 'Data Protection (General) Regulations, 2021',
    shortName: 'DPA Regulations 2021',
    year: 2021,
    areas: ['Data Protection'],
    authority: 'Office of the Data Protection Commissioner',
  },

  // Financial Services
  {
    name: 'Central Bank of Kenya Act (Cap. 491)',
    shortName: 'CBK Act',
    year: 1966,
    areas: ['Banking & Financial Services', 'Fintech & Digital Lending'],
    authority: 'Central Bank of Kenya',
  },
  {
    name: 'Banking Act (Cap. 488)',
    shortName: 'Banking Act',
    year: 1989,
    areas: ['Banking & Financial Services'],
    authority: 'Central Bank of Kenya',
  },
  {
    name: 'Microfinance Act, 2006',
    shortName: 'Microfinance Act',
    year: 2006,
    areas: ['Fintech & Digital Lending'],
    authority: 'Central Bank of Kenya',
  },
  {
    name: 'Central Bank of Kenya (Digital Credit Providers) Regulations, 2022',
    shortName: 'Digital Credit Regulations 2022',
    year: 2022,
    areas: ['Fintech & Digital Lending', 'Consumer Protection'],
    authority: 'Central Bank of Kenya',
  },

  // Payments
  {
    name: 'National Payment System Act, 2011',
    shortName: 'NPS Act 2011',
    year: 2011,
    areas: ['Payment Systems', 'Fintech & Digital Lending'],
    authority: 'Central Bank of Kenya',
  },
  {
    name: 'National Payment System Regulations, 2014',
    shortName: 'NPS Regulations 2014',
    year: 2014,
    areas: ['Payment Systems'],
    authority: 'Central Bank of Kenya',
  },

  // AML/CFT
  {
    name: 'Proceeds of Crime and Anti-Money Laundering Act, 2009',
    shortName: 'POCAMLA 2009',
    year: 2009,
    areas: ['Anti-Money Laundering (AML)', 'KYC'],
    authority: 'Financial Reporting Centre',
  },
  {
    name: 'Proceeds of Crime and Anti-Money Laundering (Amendment) Act, 2017',
    shortName: 'POCAMLA Amendment 2017',
    year: 2017,
    areas: ['Anti-Money Laundering (AML)'],
    authority: 'Financial Reporting Centre',
  },

  // Consumer Protection
  {
    name: 'Consumer Protection Act, 2012',
    shortName: 'CPA 2012',
    year: 2012,
    areas: ['Consumer Protection'],
    authority: 'Competition Authority of Kenya',
  },

  // Cybersecurity
  {
    name: 'Computer Misuse and Cybercrimes Act, 2018',
    shortName: 'Cybercrimes Act 2018',
    year: 2018,
    areas: ['Cybersecurity'],
    authority: 'Communications Authority of Kenya',
  },
  {
    name: 'Kenya Information and Communications Act (Cap. 411A)',
    shortName: 'KICA',
    year: 1998,
    areas: ['Cybersecurity', 'Data Protection'],
    authority: 'Communications Authority of Kenya',
  },

  // Capital Markets
  {
    name: 'Capital Markets Act (Cap. 485A)',
    shortName: 'CMA Act',
    year: 1989,
    areas: ['Capital Markets'],
    authority: 'Capital Markets Authority',
  },

  // Insurance
  {
    name: 'Insurance Act (Cap. 487)',
    shortName: 'Insurance Act',
    year: 2006,
    areas: ['Insurance'],
    authority: 'Insurance Regulatory Authority',
  },

  // Tax
  {
    name: 'Income Tax Act (Cap. 470)',
    shortName: 'ITA',
    year: 1973,
    areas: ['Tax Compliance'],
    authority: 'Kenya Revenue Authority',
  },
  {
    name: 'Value Added Tax Act, 2013',
    shortName: 'VAT Act 2013',
    year: 2013,
    areas: ['Tax Compliance'],
    authority: 'Kenya Revenue Authority',
  },
  {
    name: 'Tax Procedures Act, 2015',
    shortName: 'TPA 2015',
    year: 2015,
    areas: ['Tax Compliance'],
    authority: 'Kenya Revenue Authority',
  },

  // Employment
  {
    name: 'Employment Act, 2007',
    shortName: 'Employment Act 2007',
    year: 2007,
    areas: ['Employment & Labor'],
    authority: 'Ministry of Labour',
  },

  // Competition
  {
    name: 'Competition Act, 2010',
    shortName: 'Competition Act 2010',
    year: 2010,
    areas: ['Competition & Antitrust'],
    authority: 'Competition Authority of Kenya',
  },
] as const;

/**
 * Kenyan regulatory authorities
 */
export const REGULATORY_AUTHORITIES = [
  'Central Bank of Kenya (CBK)',
  'Office of the Data Protection Commissioner (ODPC)',
  'Communications Authority of Kenya (CA)',
  'Capital Markets Authority (CMA)',
  'Insurance Regulatory Authority (IRA)',
  'Kenya Revenue Authority (KRA)',
  'Financial Reporting Centre (FRC)',
  'Competition Authority of Kenya (CAK)',
  'Retirement Benefits Authority (RBA)',
  'Sacco Societies Regulatory Authority (SASRA)',
] as const;

/**
 * Error codes for API responses
 */
export const ERROR_CODES = {
  // Authentication errors (1xxx)
  INVALID_CREDENTIALS: 'AUTH_1001',
  EMAIL_NOT_VERIFIED: 'AUTH_1002',
  ACCOUNT_SUSPENDED: 'AUTH_1003',
  ACCOUNT_DEACTIVATED: 'AUTH_1004',
  INVALID_TOKEN: 'AUTH_1005',
  TOKEN_EXPIRED: 'AUTH_1006',
  REFRESH_TOKEN_INVALID: 'AUTH_1007',
  SESSION_NOT_FOUND: 'AUTH_1008',
  EMAIL_ALREADY_EXISTS: 'AUTH_1009',
  WEAK_PASSWORD: 'AUTH_1010',

  // Authorization errors (2xxx)
  INSUFFICIENT_PERMISSIONS: 'AUTHZ_2001',
  INVALID_ROLE: 'AUTHZ_2002',
  ORGANIZATION_MISMATCH: 'AUTHZ_2003',
  RESOURCE_FORBIDDEN: 'AUTHZ_2004',

  // Validation errors (3xxx)
  INVALID_INPUT: 'VAL_3001',
  MISSING_REQUIRED_FIELD: 'VAL_3002',
  INVALID_EMAIL: 'VAL_3003',
  INVALID_PHONE: 'VAL_3004',
  INVALID_DATE: 'VAL_3005',
  INVALID_FILE_TYPE: 'VAL_3006',
  FILE_TOO_LARGE: 'VAL_3007',

  // Resource errors (4xxx)
  RESOURCE_NOT_FOUND: 'RES_4001',
  USER_NOT_FOUND: 'RES_4002',
  POLICY_NOT_FOUND: 'RES_4003',
  DOCUMENT_NOT_FOUND: 'RES_4004',
  ORGANIZATION_NOT_FOUND: 'RES_4005',

  // Rate limiting errors (5xxx)
  RATE_LIMIT_EXCEEDED: 'RATE_5001',
  TOO_MANY_REQUESTS: 'RATE_5002',
  DAILY_LIMIT_EXCEEDED: 'RATE_5003',

  // AI/RAG errors (6xxx)
  AI_SERVICE_ERROR: 'AI_6001',
  POLICY_GENERATION_FAILED: 'AI_6002',
  COMPLIANCE_QUERY_FAILED: 'AI_6003',
  EMBEDDING_GENERATION_FAILED: 'AI_6004',
  VECTOR_SEARCH_FAILED: 'AI_6005',

  // Document processing errors (7xxx)
  DOCUMENT_UPLOAD_FAILED: 'DOC_7001',
  DOCUMENT_PARSING_FAILED: 'DOC_7002',
  DOCUMENT_INDEXING_FAILED: 'DOC_7003',
  INVALID_DOCUMENT_FORMAT: 'DOC_7004',

  // Database errors (8xxx)
  DATABASE_ERROR: 'DB_8001',
  TRANSACTION_FAILED: 'DB_8002',
  CONSTRAINT_VIOLATION: 'DB_8003',
  UNIQUE_VIOLATION: 'DB_8004',

  // External service errors (9xxx)
  EXTERNAL_SERVICE_ERROR: 'EXT_9001',
  EMAIL_SERVICE_ERROR: 'EXT_9002',
  STORAGE_SERVICE_ERROR: 'EXT_9003',
  PAYMENT_SERVICE_ERROR: 'EXT_9004',
  REDIS_ERROR: 'EXT_9005',
  PINECONE_ERROR: 'EXT_9006',

  // System errors (10xxx)
  INTERNAL_SERVER_ERROR: 'SYS_10001',
  SERVICE_UNAVAILABLE: 'SYS_10002',
  MAINTENANCE_MODE: 'SYS_10003',
} as const;

/**
 * Error messages for error codes
 */
export const ERROR_MESSAGES: Record<string, string> = {
  // Authentication
  [ERROR_CODES.INVALID_CREDENTIALS]: 'Invalid email or password',
  [ERROR_CODES.EMAIL_NOT_VERIFIED]: 'Please verify your email address',
  [ERROR_CODES.ACCOUNT_SUSPENDED]: 'Your account has been suspended',
  [ERROR_CODES.ACCOUNT_DEACTIVATED]: 'Your account has been deactivated',
  [ERROR_CODES.INVALID_TOKEN]: 'Invalid authentication token',
  [ERROR_CODES.TOKEN_EXPIRED]: 'Authentication token has expired',
  [ERROR_CODES.REFRESH_TOKEN_INVALID]: 'Invalid refresh token',
  [ERROR_CODES.SESSION_NOT_FOUND]: 'Session not found or expired',
  [ERROR_CODES.EMAIL_ALREADY_EXISTS]: 'Email address already in use',
  [ERROR_CODES.WEAK_PASSWORD]: 'Password does not meet security requirements',

  // Authorization
  [ERROR_CODES.INSUFFICIENT_PERMISSIONS]: 'You do not have permission to perform this action',
  [ERROR_CODES.INVALID_ROLE]: 'Invalid user role',
  [ERROR_CODES.ORGANIZATION_MISMATCH]: 'Resource belongs to a different organization',
  [ERROR_CODES.RESOURCE_FORBIDDEN]: 'Access to this resource is forbidden',

  // Validation
  [ERROR_CODES.INVALID_INPUT]: 'Invalid input provided',
  [ERROR_CODES.MISSING_REQUIRED_FIELD]: 'Required field is missing',
  [ERROR_CODES.INVALID_EMAIL]: 'Invalid email address format',
  [ERROR_CODES.INVALID_PHONE]: 'Invalid phone number format',
  [ERROR_CODES.INVALID_DATE]: 'Invalid date format',
  [ERROR_CODES.INVALID_FILE_TYPE]: 'File type not allowed',
  [ERROR_CODES.FILE_TOO_LARGE]: 'File size exceeds maximum limit',

  // Resources
  [ERROR_CODES.RESOURCE_NOT_FOUND]: 'Resource not found',
  [ERROR_CODES.USER_NOT_FOUND]: 'User not found',
  [ERROR_CODES.POLICY_NOT_FOUND]: 'Policy not found',
  [ERROR_CODES.DOCUMENT_NOT_FOUND]: 'Document not found',
  [ERROR_CODES.ORGANIZATION_NOT_FOUND]: 'Organization not found',

  // Rate limiting
  [ERROR_CODES.RATE_LIMIT_EXCEEDED]: 'Rate limit exceeded. Please try again later',
  [ERROR_CODES.TOO_MANY_REQUESTS]: 'Too many requests. Please slow down',
  [ERROR_CODES.DAILY_LIMIT_EXCEEDED]: 'Daily usage limit exceeded',

  // AI/RAG
  [ERROR_CODES.AI_SERVICE_ERROR]: 'AI service error. Please try again',
  [ERROR_CODES.POLICY_GENERATION_FAILED]: 'Failed to generate policy',
  [ERROR_CODES.COMPLIANCE_QUERY_FAILED]: 'Failed to process compliance query',
  [ERROR_CODES.EMBEDDING_GENERATION_FAILED]: 'Failed to generate embeddings',
  [ERROR_CODES.VECTOR_SEARCH_FAILED]: 'Failed to search documents',

  // Documents
  [ERROR_CODES.DOCUMENT_UPLOAD_FAILED]: 'Failed to upload document',
  [ERROR_CODES.DOCUMENT_PARSING_FAILED]: 'Failed to parse document',
  [ERROR_CODES.DOCUMENT_INDEXING_FAILED]: 'Failed to index document',
  [ERROR_CODES.INVALID_DOCUMENT_FORMAT]: 'Invalid document format',

  // Database
  [ERROR_CODES.DATABASE_ERROR]: 'Database error occurred',
  [ERROR_CODES.TRANSACTION_FAILED]: 'Database transaction failed',
  [ERROR_CODES.CONSTRAINT_VIOLATION]: 'Database constraint violation',
  [ERROR_CODES.UNIQUE_VIOLATION]: 'Duplicate entry detected',

  // External services
  [ERROR_CODES.EXTERNAL_SERVICE_ERROR]: 'External service error',
  [ERROR_CODES.EMAIL_SERVICE_ERROR]: 'Failed to send email',
  [ERROR_CODES.STORAGE_SERVICE_ERROR]: 'Storage service error',
  [ERROR_CODES.PAYMENT_SERVICE_ERROR]: 'Payment processing failed',
  [ERROR_CODES.REDIS_ERROR]: 'Cache service error',
  [ERROR_CODES.PINECONE_ERROR]: 'Vector database error',

  // System
  [ERROR_CODES.INTERNAL_SERVER_ERROR]: 'Internal server error',
  [ERROR_CODES.SERVICE_UNAVAILABLE]: 'Service temporarily unavailable',
  [ERROR_CODES.MAINTENANCE_MODE]: 'System under maintenance',
};

/**
 * Cache key prefixes
 * Matches Redis configuration
 */
export const CACHE_KEYS = {
  SESSION: 'session:',
  USER: 'user:',
  POLICY: 'policy:',
  COMPLIANCE: 'compliance:',
  RAG: 'rag:',
  TOKEN: 'token:',
  RATE_LIMIT: 'ratelimit:',
  NOTIFICATION: 'notification:',
  ANALYTICS: 'analytics:',
} as const;

/**
 * Pagination defaults
 */
export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 10,
  MAX_LIMIT: 100,
} as const;

/**
 * Date formats
 */
export const DATE_FORMATS = {
  API: 'YYYY-MM-DD',
  DISPLAY: 'DD/MM/YYYY',
  DATETIME: 'YYYY-MM-DD HH:mm:ss',
  TIME: 'HH:mm:ss',
} as const;

/**
 * Currency formats (Kenyan Shilling)
 */
export const CURRENCY = {
  CODE: 'KES',
  SYMBOL: 'KSh',
  DECIMAL_PLACES: 2,
} as const;