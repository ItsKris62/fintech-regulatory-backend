/**
 * User Module - Public API
 * Export all user-related functionality
 */

// Main module
export { userModule, UserModule } from './user.module';

// Types
export type {
  UserProfile,
  UpdateProfileInput,
  ChangeEmailInput,
  UserPreferences,
  UpdatePreferencesInput,
  ActivityLogEntry,
  ActivityAction,
  ResourceType,
  ActivityLogFilters,
  PaginatedActivityLog,
  UserStats,
  DeleteAccountInput,
  DeleteAccountResult,
  UserDataExport,
  ExportDataResult,
} from './user.types';

export {
  DEFAULT_PREFERENCES,
  USER_CACHE_KEYS,
  USER_CACHE_TTL,
  UserError,
} from './user.types';

export type { UserErrorCode } from './user.types';

// Utilities (for use in other modules)
export {
  toUserProfile,
  parsePreferences,
  mergePreferences,
  defaultPreferences,
  createActivityEntry,
  formatActivityAction,
  getActivityIcon,
  formatBytes,
  updateProfileSchema,
  updatePreferencesSchema,
  activityLogFiltersSchema,
} from './user.utils';