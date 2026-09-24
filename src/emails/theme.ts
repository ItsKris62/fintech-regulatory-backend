import { appConfig } from '@/config/app.config';
import { logger } from '@/utils/logger';

/**
 * SheriaBot Email Design System Tokens & Primitives
 * Authoritative RegTech & GovTech Design System for Kenya
 */

export const DEFAULT_R2_PUBLIC_BUCKET_URL = 'https://pub-724936356a15494f9ce61480c5225e6f.r2.dev';

if (!appConfig.publicStorage.bucketUrl) {
  logger.warn({ type: 'email_theme_public_url_missing' });
}

// FRONTEND_URL may be comma-separated for multi-origin CORS - use only the first (canonical) URL.
const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://sheriabot.com').split(',')[0].trim();

export const SHERIABOT_URL = FRONTEND_URL;

/**
 * SheriaBot Core Design Tokens
 */
export const SHERIA_EMAIL_PALETTE = {
  // Core Brand Tokens
  brand: {
    primary: '#00875A',          // SheriaBot Emerald Green (Official brand color)
    primaryHover: '#006C48',     // Deep Emerald
    primarySubtle: '#E8F5EE',    // Tinted Emerald Wash
    obsidian: '#0A0A0A',         // Obsidian Dark (Header / Brand container)
    navy: '#1A2B4A',             // Institutional Deep Navy
    gold: '#D4A843',             // Regulatory Gold (Warnings / Flags)
    goldSubtle: '#FDF8EC',       // Tinted Gold Wash
  },

  // Surfaces & Backgrounds
  surfaces: {
    appBackground: '#F4F4F5',    // Zinc-100 neutral canvas
    cardBackground: '#FFFFFF',   // Pure White container
    cardSubtle: '#FAFAFA',       // Zinc-50 interior card
    headerDark: '#0A0A0A',       // Obsidian Master Header
    borderLight: '#E4E4E7',      // Zinc-200 border
    borderSubtle: '#F4F4F5',     // Zinc-100 inner divider
    borderDark: '#27272A',       // Zinc-800 dark border
  },

  // Typography Tokens
  text: {
    primary: '#0A0A0A',          // Near Black for high readability
    body: '#27272A',             // Zinc-800 for paragraphs
    secondary: '#52525B',        // Zinc-600 for subtext
    muted: '#71717A',            // Zinc-500 for secondary copy
    faint: '#A1A1AA',            // Zinc-400 for copyright / disclaimers
    onDark: '#FFFFFF',           // Crisp White on Obsidian/Navy
    onEmerald: '#FFFFFF',        // White on Primary Green CTA
  },
} as const;

/**
 * 5-Tier Regulatory Severity & Status Matrix
 */
export const SEVERITY_MATRIX = {
  CRITICAL: {
    border: '#DC2626',
    bg: '#FEF2F2',
    text: '#991B1B',
    badge: '#DC2626',
    label: 'CRITICAL STATUTORY ALERT',
    icon: '⚠️',
  },
  HIGH: {
    border: '#EA580C',
    bg: '#FFF7ED',
    text: '#C2410C',
    badge: '#EA580C',
    label: 'HIGH REGULATORY PRIORITY',
    icon: '⚡',
  },
  MEDIUM: {
    border: '#D4A843',
    bg: '#FDF8EC',
    text: '#854D0E',
    badge: '#D4A843',
    label: 'REGULATORY NOTICE',
    icon: '📌',
  },
  LOW: {
    border: '#3B82F6',
    bg: '#EFF6FF',
    text: '#1E40AF',
    badge: '#3B82F6',
    label: 'INFORMATIONAL UPDATE',
    icon: 'ℹ️',
  },
  COMPLIANT: {
    border: '#00875A',
    bg: '#E8F5EE',
    text: '#006C48',
    badge: '#00875A',
    label: 'COMPLIANT / AUDIT PASSED',
    icon: '✓',
  },
} as const;

/**
 * Backward-compatible EMAIL_THEME constant
 */
export const EMAIL_THEME = {
  colors: {
    primary: SHERIA_EMAIL_PALETTE.brand.primary,             // #00875A (SheriaBot Emerald)
    primaryLight: '#22C55E',                                 // Green-500 for secondary accents
    accent: SHERIA_EMAIL_PALETTE.brand.primary,              // Brand emerald accent
    obsidian: SHERIA_EMAIL_PALETTE.brand.obsidian,           // #0A0A0A
    navy: SHERIA_EMAIL_PALETTE.brand.navy,                   // #1A2B4A
    gold: SHERIA_EMAIL_PALETTE.brand.gold,                   // #D4A843
    headerBackground: SHERIA_EMAIL_PALETTE.brand.obsidian,   // #0A0A0A (Obsidian Master Header)
    background: SHERIA_EMAIL_PALETTE.surfaces.appBackground, // #F4F4F5 (Zinc-100)
    cardBackground: SHERIA_EMAIL_PALETTE.surfaces.cardBackground, // #FFFFFF
    cardSubtle: SHERIA_EMAIL_PALETTE.surfaces.cardSubtle,    // #FAFAFA
    text: SHERIA_EMAIL_PALETTE.text.primary,                 // #0A0A0A
    textBody: SHERIA_EMAIL_PALETTE.text.body,                // #27272A
    textSecondary: SHERIA_EMAIL_PALETTE.text.secondary,      // #52525B
    textMuted: SHERIA_EMAIL_PALETTE.text.muted,              // #71717A
    textFaint: SHERIA_EMAIL_PALETTE.text.faint,              // #A1A1AA
    border: SHERIA_EMAIL_PALETTE.surfaces.borderLight,       // #E4E4E7
    borderDark: SHERIA_EMAIL_PALETTE.surfaces.borderDark,    // #27272A
    success: '#00875A',                                      // Emerald Green
    warning: '#D4A843',                                      // Regulatory Gold
    danger: '#DC2626',                                       // Red-600
    dangerBg: '#FEF2F2',                                     // Light red background
    warningBg: '#FDF8EC',                                    // Light gold background
    successBg: '#E8F5EE',                                    // Light emerald background
  },
  fonts: {
    body: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    sans: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    mono: "'IBM Plex Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, Courier, monospace",
    citation: "'IBM Plex Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, Courier, monospace",
  },
  spacing: {
    containerWidth: '600px',
    containerPadding: '32px',
    containerPaddingMobile: '16px',
    sectionGap: '20px',
  },
  radii: {
    container: '10px',
    card: '6px',
    badge: '4px',
    button: '6px',
  },
} as const;

const resolvedPublicStorageUrl = (
  appConfig.publicStorage?.bucketUrl ||
  process.env.R2_PUBLIC_BUCKET_URL ||
  DEFAULT_R2_PUBLIC_BUCKET_URL
).replace(/\/+$/, '');

export const LOGO_URL = `${resolvedPublicStorageUrl}/branding/Sheriabot%20logo%20-%20email.png`;
export const EMAIL_SIGNATURE_LOGO_URL = `${resolvedPublicStorageUrl}/branding/Sheriabot%20logo-Email%20signature.png`;

export const APP_NAME = 'SheriaBot';
export const SUPPORT_EMAIL = process.env.EMAIL_SUPPORT_ADDRESS || 'support@sheriabot.com';
export const CURRENT_YEAR = new Date().getFullYear();
export const REGISTERED_OFFICE = 'Nairobi, Kenya';
export const DATA_PROTECTION_DISCLAIMER =
  'SheriaBot processes compliance telemetry in accordance with the Kenya Data Protection Act, 2019 (ODPC Registered).';
export const LEGAL_DISCLAIMER =
  'SheriaBot provides regulatory intelligence and automated compliance insights for informational purposes and does not constitute formal legal counsel.';
