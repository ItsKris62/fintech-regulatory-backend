/**
 * Filename Utilities
 *
 * Safe filename normalization, title extraction, and local path generation
 * for corpus document files.
 */

// ============================================================================
// Title Normalization
// ============================================================================

/**
 * Normalize a discovered title: collapse whitespace, strip surrounding
 * punctuation, decode HTML entities.
 */
export function normalizeTitle(raw: string): string {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Derive a human-readable title from a filename.
 * Strips extension, replaces separators with spaces, title-cases.
 */
export function titleFromFilename(filename: string): string {
  const noExt = filename.replace(/\.(pdf|doc|docx|txt)$/i, '');
  const spaced = noExt.replace(/[-_]+/g, ' ').replace(/%20/g, ' ');
  return spaced
    .split(' ')
    .map((word) => {
      if (word.length <= 2) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ')
    .trim();
}

// ============================================================================
// Filename Normalization
// ============================================================================

/**
 * Normalize a filename for safe filesystem storage.
 * - Lowercases
 * - Replaces spaces and special chars with hyphens
 * - Collapses multiple hyphens
 * - Preserves extension
 * - Caps length at 120 characters
 */
export function normalizeFilename(raw: string): string {
  const extMatch = raw.match(/\.(pdf|doc|docx|txt)$/i);
  const ext = extMatch ? extMatch[0].toLowerCase() : '';
  const base = raw.replace(/\.(pdf|doc|docx|txt)$/i, '');

  const normalised = base
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120 - ext.length);

  return normalised + ext;
}

// ============================================================================
// Local Path Generation
// ============================================================================

/**
 * Generate a safe proposed local path for a candidate document.
 *
 * @param country - lowercase country folder name (e.g. "malawi", "nigeria")
 * @param category - category subfolder (e.g. "payments", "aml-cft")
 * @param filename - raw or normalized filename
 * @returns relative path like "documents/malawi/payments/some-document.pdf"
 */
export function generateLocalPath(
  country: string,
  category: string,
  filename: string,
): string {
  const safeCountry = country.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const safeCategory = category.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const safeFilename = normalizeFilename(filename);

  return `documents/${safeCountry}/${safeCategory}/${safeFilename}`;
}

// ============================================================================
// Slug generation for candidate IDs
// ============================================================================

/**
 * Generate a URL-safe slug from a title for use as part of candidate IDs.
 */
export function slugify(text: string, maxLength = 60): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLength);
}

// ============================================================================
// Category Suggestion
// ============================================================================

/**
 * Suggest a category based on title keywords.
 * Returns the best-matching category or 'other'.
 */
export function suggestCategory(title: string): string {
  const t = title.toLowerCase();

  if (t.includes('data protection') || t.includes('privacy') || t.includes('personal data'))
    return 'data-protection';
  if (t.includes('aml') || t.includes('anti-money') || t.includes('money laundering') || t.includes('proceeds of crime') || t.includes('financial intelligence'))
    return 'aml-cft';
  if (t.includes('payment') || t.includes('mobile money') || t.includes('e-money'))
    return 'payments';
  if (t.includes('cybersecurity') || t.includes('cyber security') || t.includes('cybercrimes') || t.includes('computer misuse'))
    return 'cybersecurity';
  if (t.includes('banking') || t.includes('prudential') || t.includes('credit') || t.includes('deposit'))
    return 'banking';
  if (t.includes('microfinance') || t.includes('micro-finance') || t.includes('micro finance'))
    return 'microfinance';
  if (t.includes('capital market') || t.includes('securities') || t.includes('crowdfunding'))
    return 'capital-markets';
  if (t.includes('insurance'))
    return 'insurance';
  if (t.includes('consumer protection'))
    return 'consumer-protection';
  if (t.includes('digital lending') || t.includes('digital credit'))
    return 'digital-lending';
  if (t.includes('open banking') || t.includes('open-banking'))
    return 'open-banking';
  if (t.includes('tax') || t.includes('fiscal') || t.includes('revenue') || t.includes('finance act') || t.includes('finance bill'))
    return 'tax';
  if (t.includes('artificial intelligence') || t.includes(' ai '))
    return 'ai-governance';
  if (t.includes('cloud'))
    return 'cloud';
  if (t.includes('ict') || t.includes('telecommunication') || t.includes('communications'))
    return 'ict';
  if (t.includes('accessibility') || t.includes('wcag'))
    return 'accessibility';
  if (t.includes('guideline') || t.includes('guidance') || t.includes('circular'))
    return 'guidance';

  return 'other';
}

// ============================================================================
// Document Type Suggestion
// ============================================================================

/**
 * Suggest a document type based on title keywords.
 */
export function suggestDocumentType(title: string): string {
  const t = title.toLowerCase();

  if (t.includes(' act') || t.includes(' act,')) return 'ACT';
  if (t.includes('regulation') || t.includes('regulatory')) return 'REGULATION';
  if (t.includes('guideline') || t.includes('guidance note')) return 'GUIDELINE';
  if (t.includes('directive')) return 'DIRECTIVE';
  if (t.includes('circular')) return 'CIRCULAR';
  if (t.includes('framework')) return 'FRAMEWORK';
  if (t.includes('policy')) return 'POLICY';
  if (t.includes('standard')) return 'STANDARD';
  if (t.includes('report')) return 'REPORT';
  if (t.includes('draft')) return 'DRAFT';
  if (t.includes('checklist')) return 'CHECKLIST';

  return 'OTHER';
}

/**
 * Suggest authority status based on title keywords.
 */
export function suggestAuthorityStatus(title: string): string {
  const t = title.toLowerCase();

  if (t.includes('draft')) return 'DRAFT';
  if (t.includes('consultation')) return 'CONSULTATION';
  if (t.includes('guidance') || t.includes('guideline')) return 'GUIDANCE';
  if (t.includes('report')) return 'REPORT';

  return 'UNKNOWN';
}
