/**
 * Discover Sources CLI
 *
 * Scans official source registries, extracts candidate document links,
 * and writes candidate manifests + reports to `documents/_incoming/`.
 *
 * Usage:
 *   pnpm corpus:discover --country=malawi
 *   pnpm corpus:discover --country=nigeria
 *   pnpm corpus:discover --all
 *   pnpm corpus:discover --country=malawi --dry-run
 *
 * Phase 3 — discovery only. Never auto-approves.
 */

import {
  loadSourceRegistry,
  getKnownSourceCountries,
} from './source-registry-loader';

import {
  loadCandidateManifest,
  writeCandidateManifest,
  getDiscoveryReportPath,
  writeReport,
} from './candidate-loader';

import {
  resolveUrl,
  isAllowedDomain,
  extractDocumentLinks,
  extractFileExtension,
  extractFilenameFromUrl,
} from './url-utils';

import {
  normalizeTitle,
  titleFromFilename,
  suggestCategory,
  suggestDocumentType,
  suggestAuthorityStatus,
  generateLocalPath,
  slugify,
} from './filename-utils';

import { generateDiscoveryReport } from './discovery-report';

import type { CandidateEntry, CandidateCountry } from './candidate.schema';
import type { SourceRegistryEntry, SourceCountry } from './source-registry.schema';

// ============================================================================
// CLI Arg Parsing
// ============================================================================

function parseArgs(): {
  countries: CandidateCountry[];
  dryRun: boolean;
} {
  const args = process.argv.slice(2);

  let countries: CandidateCountry[] = [];
  let dryRun = false;

  for (const arg of args) {
    if (arg === '--all') {
      countries = getKnownSourceCountries() as CandidateCountry[];
    } else if (arg.startsWith('--country=')) {
      const val = arg.slice('--country='.length).toLowerCase();
      const map: Record<string, CandidateCountry> = {
        malawi: 'Malawi',
        nigeria: 'Nigeria',
      };
      if (!map[val]) {
        console.error(`❌ Unknown country: "${val}". Supported: malawi, nigeria`);
        process.exit(1);
      }
      countries.push(map[val]);
    } else if (arg === '--dry-run') {
      dryRun = true;
    }
  }

  if (countries.length === 0) {
    console.error('Usage: pnpm corpus:discover --country=<name> | --all [--dry-run]');
    process.exit(1);
  }

  return { countries, dryRun };
}

// ============================================================================
// Discovery Engine
// ============================================================================

interface DiscoveryResult {
  country: CandidateCountry;
  candidates: CandidateEntry[];
  sourcesScanned: SourceRegistryEntry[];
  errors: string[];
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'SheriaBot-Corpus-Discovery/1.0 (legal-document-indexer)',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return null;
    }
    return await response.text();
  } catch {
    return null;
  }
}

async function discoverFromSource(
  source: SourceRegistryEntry,
  existingUrls: Set<string>,
  existingTitles: Set<string>,
  candidateCounter: { count: number },
  dryRun: boolean,
): Promise<{ candidates: CandidateEntry[]; errors: string[] }> {
  const candidates: CandidateEntry[] = [];
  const errors: string[] = [];
  const country = source.country as CandidateCountry;
  const jurisdictionCode = country === 'Malawi' ? 'MW' : 'NG';
  const countryFolder = country.toLowerCase();
  const now = new Date().toISOString();

  if (dryRun) {
    console.log(`  ⏩ [DRY RUN] Skipping live fetch for: ${source.baseUrl}`);
    return { candidates, errors };
  }

  if (source.crawlMode === 'manual-only') {
    console.log(`  ⏩ Skipping manual-only source: ${source.regulator}`);
    return { candidates, errors };
  }

  console.log(`  🔍 Fetching: ${source.baseUrl}`);
  const html = await fetchPage(source.baseUrl);
  if (!html) {
    errors.push(`Failed to fetch ${source.baseUrl}`);
    return { candidates, errors };
  }

  const links = extractDocumentLinks(html);
  console.log(`  📄 Found ${links.length} document links`);

  for (const link of links) {
    const resolved = resolveUrl(link.href, source.baseUrl);
    if (!resolved) continue;

    if (!isAllowedDomain(resolved, source.allowedDomains)) {
      continue; // Silently skip external domains
    }

    // Duplicate URL check
    if (existingUrls.has(resolved)) continue;
    existingUrls.add(resolved);

    // Derive title
    const rawTitle =
      link.text && link.text.length > 3
        ? link.text
        : titleFromFilename(extractFilenameFromUrl(resolved) ?? 'untitled');
    const normalized = normalizeTitle(rawTitle);

    // Duplicate title check (fuzzy via normalized slug)
    const titleSlug = slugify(normalized);
    if (existingTitles.has(titleSlug)) continue;
    existingTitles.add(titleSlug);

    candidateCounter.count++;
    const num = String(candidateCounter.count).padStart(3, '0');
    const ext = extractFileExtension(resolved);
    const category = source.categories.length === 1
      ? source.categories[0]
      : suggestCategory(normalized);
    const docType = suggestDocumentType(normalized);

    const candidate: CandidateEntry = {
      id: `${jurisdictionCode.toLowerCase()}-candidate-${slugify(normalized, 50)}-${num}`,
      country,
      jurisdictionCode,
      discoveredTitle: rawTitle,
      normalizedTitle: normalized,
      sourceUrl: resolved,
      sourcePageUrl: source.baseUrl,
      regulator: source.regulator,
      suggestedCategory: category as any,
      suggestedDocumentType: docType as any,
      suggestedAuthorityStatus: suggestAuthorityStatus(normalized) as any,
      suggestedIsBinding: null,
      priority: 'UNKNOWN',
      decision: 'NEEDS_REVIEW',
      decisionReason: null,
      reviewedBy: null,
      reviewedAt: null,
      discoveredAt: now,
      contentType: null,
      fileExtension: ext ?? null,
      proposedLocalPath: generateLocalPath(countryFolder, category, extractFilenameFromUrl(resolved) ?? `document-${num}.pdf`),
      downloadedLocalPath: null,
      checksumSha256: null,
      duplicateOf: null,
      tags: [],
      notes: null,
    };

    candidates.push(candidate);
  }

  return { candidates, errors };
}

async function discoverCountry(
  country: CandidateCountry,
  dryRun: boolean,
): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {
    country,
    candidates: [],
    sourcesScanned: [],
    errors: [],
  };

  // Load source registry
  const registryResult = loadSourceRegistry(country as SourceCountry);
  if (registryResult.errors.length > 0) {
    result.errors.push(...registryResult.errors);
    return result;
  }

  // Load existing candidates to avoid duplicates
  const existingResult = loadCandidateManifest(country);
  const existingUrls = new Set<string>(existingResult.entries.map((e) => e.sourceUrl));
  const existingTitles = new Set<string>(existingResult.entries.map((e) => slugify(e.normalizedTitle)));

  const candidateCounter = { count: existingResult.entries.length };

  // Process enabled sources
  const enabledSources = registryResult.enabledSources;
  result.sourcesScanned = enabledSources;

  console.log(`\n📋 ${country}: ${enabledSources.length} enabled sources`);

  for (const source of enabledSources) {
    const { candidates, errors } = await discoverFromSource(
      source,
      existingUrls,
      existingTitles,
      candidateCounter,
      dryRun,
    );
    result.candidates.push(...candidates);
    result.errors.push(...errors);
  }

  return result;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const { countries, dryRun } = parseArgs();

  console.log('\n🔍 SheriaBot — Corpus Source Discovery\n');
  console.log(`Countries: ${countries.join(', ')}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);

  let hasErrors = false;

  for (const country of countries) {
    const result = await discoverCountry(country, dryRun);

    console.log(`\n────────────────────────────────────────────────────────────`);
    console.log(`📋 ${country}: ${result.candidates.length} new candidates found`);
    if (result.errors.length > 0) {
      console.log(`⚠️  ${result.errors.length} errors`);
      hasErrors = true;
    }

    // Merge with existing candidates
    const existingResult = loadCandidateManifest(country);
    const allEntries = [...existingResult.entries, ...result.candidates];

    // Write candidate manifest
    const manifest = {
      version: 1,
      country,
      jurisdictionCode: country === 'Malawi' ? 'MW' as const : 'NG' as const,
      discoveredAt: new Date().toISOString(),
      entries: allEntries,
    };

    if (!dryRun) {
      writeCandidateManifest(country, manifest);
      console.log(`  ✅ Candidate manifest written`);
    } else {
      console.log(`  ⏩ [DRY RUN] Would write ${allEntries.length} entries to candidate manifest`);
    }

    // Write discovery report
    const report = generateDiscoveryReport(
      country,
      result.sourcesScanned,
      allEntries,
      result.errors,
      dryRun,
    );

    if (!dryRun) {
      writeReport(getDiscoveryReportPath(country), report);
      console.log(`  ✅ Discovery report written`);
    } else {
      console.log(`  ⏩ [DRY RUN] Would write discovery report`);
    }
  }

  console.log('\n════════════════════════════════════════════════════════════');
  if (hasErrors) {
    console.log('⚠️  DISCOVERY COMPLETED WITH ERRORS');
  } else {
    console.log('✅ DISCOVERY COMPLETED');
  }
  console.log('════════════════════════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('Fatal error during discovery:', err);
  process.exit(1);
});
