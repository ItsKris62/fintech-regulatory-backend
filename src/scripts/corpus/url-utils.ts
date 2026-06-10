/**
 * URL Utilities
 *
 * Safe URL resolution, domain allowlist enforcement, and document link
 * extraction from HTML content.
 */

import { URL } from 'url';

// ============================================================================
// Document extensions recognised as potential corpus files
// ============================================================================

export const DOCUMENT_EXTENSIONS = ['.pdf', '.doc', '.docx', '.txt'] as const;
export type DocumentExtension = (typeof DOCUMENT_EXTENSIONS)[number];

// ============================================================================
// URL Resolution
// ============================================================================

/**
 * Resolve a potentially relative URL against a base URL.
 * Returns null if the result is not a valid HTTP(S) URL.
 */
export function resolveUrl(href: string, baseUrl: string): string | null {
  try {
    const resolved = new URL(href, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null;
    }
    return resolved.href;
  } catch {
    return null;
  }
}

// ============================================================================
// Domain Enforcement
// ============================================================================

/**
 * Check whether a URL's hostname matches any of the allowed domains.
 * Supports exact match and subdomain matching (e.g. "example.com" allows
 * "www.example.com" and "docs.example.com").
 */
export function isAllowedDomain(url: string, allowedDomains: string[]): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    for (const domain of allowedDomains) {
      const d = domain.toLowerCase();
      if (hostname === d || hostname.endsWith(`.${d}`)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

// ============================================================================
// Link Extraction
// ============================================================================

/**
 * Simple regex-based extraction of document links from HTML content.
 * Extracts <a href="..."> links whose href ends with a known document extension.
 *
 * Returns an array of { href, text } objects with raw (unresolved) hrefs.
 */
export function extractDocumentLinks(
  html: string,
): Array<{ href: string; text: string }> {
  const results: Array<{ href: string; text: string }> = [];

  // Match <a ...href="..."...>text</a> patterns
  const linkRegex = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1].trim();
    // Strip HTML tags from link text
    const text = match[2].replace(/<[^>]*>/g, '').trim();

    if (isDocumentUrl(href)) {
      results.push({ href, text });
    }
  }

  // Also find standalone hrefs to documents (not in <a> tags)
  // e.g. in onclick handlers or data attributes
  const hrefRegex = /(?:href|src|data-url)\s*=\s*["']([^"']+\.(?:pdf|doc|docx|txt))["']/gi;
  while ((match = hrefRegex.exec(html)) !== null) {
    const href = match[1].trim();
    // Avoid duplicates
    if (!results.some((r) => r.href === href)) {
      results.push({ href, text: '' });
    }
  }

  return results;
}

/**
 * Check if a URL or path ends with a known document extension.
 */
export function isDocumentUrl(urlOrPath: string): boolean {
  const lower = urlOrPath.toLowerCase().split('?')[0].split('#')[0];
  return DOCUMENT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Extract the file extension from a URL or path (without the dot).
 * Returns null if no recognised extension found.
 */
export function extractFileExtension(urlOrPath: string): string | null {
  const clean = urlOrPath.toLowerCase().split('?')[0].split('#')[0];
  for (const ext of DOCUMENT_EXTENSIONS) {
    if (clean.endsWith(ext)) {
      return ext.slice(1); // remove leading dot
    }
  }
  return null;
}

/**
 * Extract the filename portion from a URL path.
 */
export function extractFilenameFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    if (pathParts.length === 0) return null;
    const last = decodeURIComponent(pathParts[pathParts.length - 1]);
    return last || null;
  } catch {
    return null;
  }
}
