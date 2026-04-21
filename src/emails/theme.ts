/**
 * SheriaBot Email Design System
 * Shared constants for all email templates
 */

// Logo is served from the R2 public bucket so it loads even when the
// frontend is down and is immune to Vercel cold-start delays.
const R2_PUBLIC_URL = process.env.R2_PUBLIC_BUCKET_URL ?? '';
// FRONTEND_URL may be comma-separated for multi-origin CORS  -  use only the first (canonical) URL.
const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://sheriabot.com').split(',')[0].trim();

export const SHERIABOT_URL = FRONTEND_URL;

export const EMAIL_THEME = {
  colors: {
    primary: '#15803D',       // Green-700  -  SheriaBot brand green (matches app primary)
    primaryLight: '#22C55E',  // Green-500  -  lighter green for links and accents
    accent: '#15803D',        // Brand green accent
    background: '#F8F9FA',    // Light gray background
    cardBackground: '#FFFFFF',// White card/content area
    text: '#111827',          // Near-black for body text
    textSecondary: '#6B7280', // Gray for secondary text
    textMuted: '#9CA3AF',     // Lighter gray for footer text
    border: '#E5E7EB',        // Light border color
    success: '#15803D',       // Green for success states
    warning: '#D97706',       // Amber for warnings
    danger: '#DC2626',        // Red for errors/urgent
    dangerBg: '#FEF2F2',      // Light red background
    warningBg: '#FFFBEB',     // Light amber background
    successBg: '#F0FDF4',     // Light green background
  },
  fonts: {
    body: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  spacing: {
    containerWidth: '600px',
    containerPadding: '40px',
    sectionGap: '24px',
  },
} as const;

export const LOGO_URL = `${R2_PUBLIC_URL}/branding/email-signature-logo.png`;

export const APP_NAME = 'SheriaBot';
export const SUPPORT_EMAIL = process.env.EMAIL_SUPPORT_ADDRESS || 'support@sheriabot.com';
export const CURRENT_YEAR = new Date().getFullYear();
