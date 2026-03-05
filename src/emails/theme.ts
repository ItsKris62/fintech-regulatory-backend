/**
 * SheriaBot Email Design System
 * Shared constants for all email templates
 */

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://sheriabot.com';

export const EMAIL_THEME = {
  colors: {
    primary: '#1E3A5F',       // Deep navy — authority, trust, compliance
    primaryLight: '#2E5A8F',  // Lighter navy for hover states
    accent: '#D4A843',        // Gold/amber — premium, fintech
    background: '#F8F9FA',    // Light gray background
    cardBackground: '#FFFFFF',// White card/content area
    text: '#1A1A2E',          // Near-black for body text
    textSecondary: '#6B7280', // Gray for secondary text
    textMuted: '#9CA3AF',     // Lighter gray for footer text
    border: '#E5E7EB',        // Light border color
    success: '#059669',       // Green for success states
    warning: '#D97706',       // Amber for warnings
    danger: '#DC2626',        // Red for errors/urgent
    dangerBg: '#FEF2F2',      // Light red background
    warningBg: '#FFFBEB',     // Light amber background
    successBg: '#ECFDF5',     // Light green background
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

export const LOGO_URL = `${FRONTEND_URL}/email-signature-logo.png`;

export const APP_NAME = 'SheriaBot';
export const SUPPORT_EMAIL = process.env.EMAIL_SUPPORT_ADDRESS || 'support@sheriabot.com';
export const CURRENT_YEAR = new Date().getFullYear();
