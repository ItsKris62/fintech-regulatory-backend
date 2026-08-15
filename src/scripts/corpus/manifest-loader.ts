/**
 * Corpus Manifest Loader
 *
 * Loads, validates, and normalizes corpus manifest files. Provides safe path
 * resolution rooted under the project `documents/` directory.
 *
 * This loader is read-only and does NOT drive ingestion. It is used by
 * validation and inventory utilities.
 */

import fs from 'fs';
import path from 'path';

import {
  CorpusManifestSchema,
  CorpusManifestEntrySchema,
  type CorpusManifest,
  type CorpusManifestEntry,
  type Country,
  COUNTRY_JURISDICTION_MAP,
} from './manifest.schema';

// ============================================================================
// Types
// ============================================================================

export interface ManifestLoadResult {
  /** The country this manifest belongs to. */
  country: Country;
  /** Parsed and validated manifest. Null if load failed. */
  manifest: CorpusManifest | null;
  /** Validated entries (only those that passed individual validation). */
  validEntries: CorpusManifestEntry[];
  /** Errors encountered during load and validation. */
  errors: ManifestError[];
  /** Warnings (non-fatal issues). */
  warnings: string[];
}

export interface ManifestError {
  entryId?: string;
  field?: string;
  message: string;
}

// ============================================================================
// Constants
// ============================================================================

const KNOWN_COUNTRIES: Country[] = ['Kenya', 'Malawi', 'Nigeria', 'Rwanda', 'International'];

const COUNTRY_FOLDER_MAP: Record<Country, string> = {
  Kenya: 'kenya',
  Malawi: 'malawi',
  Nigeria: 'nigeria',
  Rwanda: 'rwanda',
  International: 'international',
};

// ============================================================================
// Path Helpers
// ============================================================================

/**
 * Resolve the project root. Assumes this file lives at
 * `<root>/src/scripts/corpus/manifest-loader.ts`.
 */
function getProjectRoot(): string {
  return path.resolve(__dirname, '..', '..', '..');
}

/**
 * Resolve the documents root.
 */
export function getDocumentsRoot(): string {
  return path.join(getProjectRoot(), 'documents');
}

/**
 * Get the manifest.json path for a given country.
 */
export function getManifestPath(country: Country): string {
  const folder = COUNTRY_FOLDER_MAP[country];
  return path.join(getDocumentsRoot(), folder, 'manifest.json');
}

/**
 * Safely resolve a `localPath` from a manifest entry to an absolute path.
 * Validates that the resolved path is within `documents/`.
 *
 * @returns absolute path or null if unsafe
 */
export function resolveLocalPath(localPath: string): string | null {
  const docsRoot = getDocumentsRoot();
  // localPath is relative to project root, e.g. "documents/kenya/foo.pdf"
  const abs = path.resolve(getProjectRoot(), localPath.replace(/\//g, path.sep));
  const normalised = path.normalize(abs);

  // Ensure it's under documents/
  if (!normalised.startsWith(docsRoot)) {
    return null;
  }

  return normalised;
}

// ============================================================================
// Loader
// ============================================================================

/**
 * Load and validate a single country's manifest.
 */
export function loadManifest(country: Country): ManifestLoadResult {
  const result: ManifestLoadResult = {
    country,
    manifest: null,
    validEntries: [],
    errors: [],
    warnings: [],
  };

  const manifestPath = getManifestPath(country);

  // Check existence
  if (!fs.existsSync(manifestPath)) {
    result.errors.push({
      message: `Manifest file not found: ${manifestPath}`,
    });
    return result;
  }

  // Read and parse JSON
  let rawJson: unknown;
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    rawJson = JSON.parse(raw);
  } catch (err: any) {
    result.errors.push({
      message: `Failed to parse manifest JSON: ${err?.message ?? 'Unknown error'}`,
    });
    return result;
  }

  // Validate top-level manifest schema
  const parseResult = CorpusManifestSchema.safeParse(rawJson);

  if (!parseResult.success) {
    for (const issue of parseResult.error.issues) {
      result.errors.push({
        field: issue.path.join('.'),
        message: issue.message,
      });
    }
    return result;
  }

  const manifest = parseResult.data;
  result.manifest = manifest;

  // Validate manifest-level country/jurisdiction match
  const allowedCodes = COUNTRY_JURISDICTION_MAP[manifest.country];
  if (!allowedCodes?.includes(manifest.jurisdictionCode)) {
    result.errors.push({
      message: `Manifest jurisdictionCode "${manifest.jurisdictionCode}" does not match country "${manifest.country}"`,
    });
  }

  // Cross-entry validation
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();

  for (const entry of manifest.entries) {
    // Duplicate ID check
    if (seenIds.has(entry.id)) {
      result.errors.push({
        entryId: entry.id,
        field: 'id',
        message: `Duplicate entry id: "${entry.id}"`,
      });
    }
    seenIds.add(entry.id);

    // Duplicate localPath check
    if (seenPaths.has(entry.localPath)) {
      result.errors.push({
        entryId: entry.id,
        field: 'localPath',
        message: `Duplicate localPath: "${entry.localPath}"`,
      });
    }
    seenPaths.add(entry.localPath);

    // Re-validate individual entry (Zod already validated, but we track per-entry)
    const entryResult = CorpusManifestEntrySchema.safeParse(entry);
    if (!entryResult.success) {
      for (const issue of entryResult.error.issues) {
        result.errors.push({
          entryId: entry.id,
          field: issue.path.join('.'),
          message: issue.message,
        });
      }
      continue;
    }

    // File existence check (non-fatal for PLACEHOLDER entries)
    const absPath = resolveLocalPath(entry.localPath);
    if (!absPath) {
      result.errors.push({
        entryId: entry.id,
        field: 'localPath',
        message: `localPath "${entry.localPath}" resolves outside documents/ directory`,
      });
      continue;
    }

    if (!fs.existsSync(absPath)) {
      if (entry.reviewStatus === 'PLACEHOLDER') {
        result.warnings.push(
          `[${entry.id}] File not found (PLACEHOLDER): ${entry.localPath}`,
        );
      } else {
        result.errors.push({
          entryId: entry.id,
          field: 'localPath',
          message: `File not found: ${entry.localPath}`,
        });
      }
    }

    // Checksum verification (when present and file exists)
    // NOTE: Checksum verification is async and handled by the validate-manifest CLI.
    // Here we just note if checksum is missing for non-placeholder entries.
    if (
      entry.reviewStatus !== 'PLACEHOLDER' &&
      entry.reviewStatus !== 'NEEDS_REVIEW' &&
      !entry.checksumSha256
    ) {
      result.warnings.push(
        `[${entry.id}] checksumSha256 is null for reviewStatus "${entry.reviewStatus}"`,
      );
    }

    result.validEntries.push(entry);
  }

  return result;
}

/**
 * Load manifests for all known countries.
 */
export function loadAllManifests(): ManifestLoadResult[] {
  return KNOWN_COUNTRIES.map((country) => loadManifest(country));
}

/**
 * Get the list of known countries.
 */
export function getKnownCountries(): Country[] {
  return [...KNOWN_COUNTRIES];
}
