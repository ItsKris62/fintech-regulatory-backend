/**
 * Source Registry Loader
 *
 * Loads and validates per-country source registry JSON files from
 * `scripts/corpus/sources/<country>.sources.json`.
 */

import fs from 'fs';
import path from 'path';

import {
  SourceRegistrySchema,
  type SourceRegistry,
  type SourceRegistryEntry,
  type SourceCountry,
} from './source-registry.schema';

// ============================================================================
// Types
// ============================================================================

export interface SourceRegistryLoadResult {
  country: SourceCountry;
  registry: SourceRegistry | null;
  sources: SourceRegistryEntry[];
  enabledSources: SourceRegistryEntry[];
  errors: string[];
}

// ============================================================================
// Constants
// ============================================================================

const COUNTRY_FILE_MAP: Record<SourceCountry, string> = {
  Malawi: 'malawi.sources.json',
  Nigeria: 'nigeria.sources.json',
};

const KNOWN_COUNTRIES: SourceCountry[] = ['Malawi', 'Nigeria'];

// ============================================================================
// Helpers
// ============================================================================

function getSourcesDir(): string {
  return path.resolve(__dirname, '..', '..', '..', 'scripts', 'corpus', 'sources');
}

function getSourceRegistryPath(country: SourceCountry): string {
  return path.join(getSourcesDir(), COUNTRY_FILE_MAP[country]);
}

// ============================================================================
// Loader
// ============================================================================

export function loadSourceRegistry(country: SourceCountry): SourceRegistryLoadResult {
  const result: SourceRegistryLoadResult = {
    country,
    registry: null,
    sources: [],
    enabledSources: [],
    errors: [],
  };

  const registryPath = getSourceRegistryPath(country);

  if (!fs.existsSync(registryPath)) {
    result.errors.push(`Source registry not found: ${registryPath}`);
    return result;
  }

  let rawJson: unknown;
  try {
    const raw = fs.readFileSync(registryPath, 'utf-8');
    rawJson = JSON.parse(raw);
  } catch (err: any) {
    result.errors.push(`Failed to parse source registry JSON: ${err?.message ?? 'Unknown'}`);
    return result;
  }

  const parseResult = SourceRegistrySchema.safeParse(rawJson);
  if (!parseResult.success) {
    for (const issue of parseResult.error.issues) {
      result.errors.push(`[${issue.path.join('.')}] ${issue.message}`);
    }
    return result;
  }

  const registry = parseResult.data;
  result.registry = registry;
  result.sources = registry.sources;
  result.enabledSources = registry.sources.filter((s) => s.enabled);

  // Duplicate ID check
  const seenIds = new Set<string>();
  for (const src of registry.sources) {
    if (seenIds.has(src.id)) {
      result.errors.push(`Duplicate source id: "${src.id}"`);
    }
    seenIds.add(src.id);
  }

  return result;
}

export function loadAllSourceRegistries(): SourceRegistryLoadResult[] {
  return KNOWN_COUNTRIES.map((c) => loadSourceRegistry(c));
}

export function getKnownSourceCountries(): SourceCountry[] {
  return [...KNOWN_COUNTRIES];
}
