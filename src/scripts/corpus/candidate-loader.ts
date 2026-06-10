/**
 * Candidate Loader
 *
 * Loads, validates, and writes candidate manifest files under
 * `documents/_incoming/<country>/candidate-manifest.json`.
 */

import fs from 'fs';
import path from 'path';

import {
  CandidateManifestSchema,
  type CandidateManifest,
  type CandidateEntry,
  type CandidateCountry,
} from './candidate.schema';

// ============================================================================
// Types
// ============================================================================

export interface CandidateLoadResult {
  country: CandidateCountry;
  manifest: CandidateManifest | null;
  entries: CandidateEntry[];
  errors: string[];
}

// ============================================================================
// Constants
// ============================================================================

const COUNTRY_FOLDER_MAP: Record<CandidateCountry, string> = {
  Malawi: 'malawi',
  Nigeria: 'nigeria',
};

// ============================================================================
// Path Helpers
// ============================================================================

function getProjectRoot(): string {
  return path.resolve(__dirname, '..', '..', '..');
}

export function getIncomingDir(country: CandidateCountry): string {
  return path.join(getProjectRoot(), 'documents', '_incoming', COUNTRY_FOLDER_MAP[country]);
}

export function getCandidateManifestPath(country: CandidateCountry): string {
  return path.join(getIncomingDir(country), 'candidate-manifest.json');
}

export function getDiscoveryReportPath(country: CandidateCountry): string {
  return path.join(getIncomingDir(country), 'discovery-report.md');
}

export function getDownloadReportPath(country: CandidateCountry): string {
  return path.join(getIncomingDir(country), 'download-report.md');
}

// ============================================================================
// Loader
// ============================================================================

/**
 * Load and validate an existing candidate manifest.
 */
export function loadCandidateManifest(country: CandidateCountry): CandidateLoadResult {
  const result: CandidateLoadResult = {
    country,
    manifest: null,
    entries: [],
    errors: [],
  };

  const manifestPath = getCandidateManifestPath(country);

  if (!fs.existsSync(manifestPath)) {
    // Not an error — may not exist yet
    return result;
  }

  let rawJson: unknown;
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    rawJson = JSON.parse(raw);
  } catch (err: any) {
    result.errors.push(`Failed to parse candidate manifest: ${err?.message ?? 'Unknown'}`);
    return result;
  }

  const parseResult = CandidateManifestSchema.safeParse(rawJson);
  if (!parseResult.success) {
    for (const issue of parseResult.error.issues) {
      result.errors.push(`[${issue.path.join('.')}] ${issue.message}`);
    }
    return result;
  }

  result.manifest = parseResult.data;
  result.entries = parseResult.data.entries;

  // Duplicate ID check
  const seenIds = new Set<string>();
  for (const entry of result.entries) {
    if (seenIds.has(entry.id)) {
      result.errors.push(`Duplicate candidate id: "${entry.id}"`);
    }
    seenIds.add(entry.id);
  }

  // Duplicate sourceUrl check
  const seenUrls = new Set<string>();
  for (const entry of result.entries) {
    if (seenUrls.has(entry.sourceUrl)) {
      result.errors.push(`Duplicate sourceUrl: "${entry.sourceUrl}" (entry: ${entry.id})`);
    }
    seenUrls.add(entry.sourceUrl);
  }

  return result;
}

// ============================================================================
// Writer
// ============================================================================

/**
 * Write a candidate manifest to disk. Creates directories if needed.
 */
export function writeCandidateManifest(
  country: CandidateCountry,
  manifest: CandidateManifest,
): void {
  const manifestPath = getCandidateManifestPath(country);
  const dir = path.dirname(manifestPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

/**
 * Write a markdown report to disk.
 */
export function writeReport(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, content, 'utf-8');
}
