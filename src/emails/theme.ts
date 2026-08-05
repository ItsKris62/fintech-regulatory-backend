/**
 * SheriaBot Email Design System
 * Shared constants for all email templates
 */

// Logo is served from the R2 public bucket so it loads even when the
// frontend is down and is immune to Vercel cold-start delays.
const R2_PUBLIC_URL =
  process.env.R2_PUBLIC_BUCKET_URL ??
  process.env.NEXT_PUBLIC_R2_ASSETS_URL ??
  'https://pub-724936356a15494f9ce61480c5225e6f.r2.dev';
// FRONTEND_URL may be comma-separated for multi-origin CORS  -  use only the first (canonical) URL.
const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://sheriabot.com').split(',')[0].trim();

export const SHERIABOT_URL = FRONTEND_URL;

export const EMAIL_THEME = {
  colors: {
    primary: '#15803D',       // Green-700  -  SheriaBot brand green (matches app primary)
    primaryLight: '#22C55E',  // Green-500  -  lighter green for links and accents
    accent: '#15803D',        // Brand green accent
    headerBackground: '#0F172A', // Dark Slate for high-contrast, premium email headers
    background: '#F8FAFC',    // Slate-50 background
    cardBackground: '#FFFFFF',// White card/content area
    text: '#1E293B',          // Slate-800 for main body text
    textSecondary: '#64748B', // Slate-500 for secondary text
    textMuted: '#94A3B8',     // Slate-400 for footer text
    border: '#E2E8F0',        // Light border color
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

export const LOGO_URL = `${R2_PUBLIC_URL}/branding/Sheriabot%20logo%20-%20email.png`;

export const APP_NAME = 'SheriaBot';
export const SUPPORT_EMAIL = process.env.EMAIL_SUPPORT_ADDRESS || 'support@sheriabot.com';
export const CURRENT_YEAR = new Date().getFullYear();
