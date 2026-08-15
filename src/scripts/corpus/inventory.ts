/**
 * Corpus Inventory Reporter (CLI)
 *
 * Reads all manifests and produces a summary report:
 *   - total entries
 *   - approved / placeholder / needs-review counts
 *   - missing files
 *   - missing source URLs
 *   - missing checksums
 *   - category counts
 *   - country counts
 *   - authority status counts
 *
 * Usage:
 *   pnpm corpus:inventory --all
 *   pnpm corpus:inventory --country=kenya
 */

import fs from 'fs';

import {
  loadManifest,
  getKnownCountries,
  resolveLocalPath,
  type ManifestLoadResult,
} from './manifest-loader';
import type { Country, CorpusManifestEntry } from './manifest.schema';

// ============================================================================
// CLI Argument Parsing
// ============================================================================

function parseArgs(): { countries: Country[] } {
  const args = process.argv.slice(2);
  let countries: Country[] = [];

  for (const arg of args) {
    if (arg === '--all') {
      countries = getKnownCountries();
    } else if (arg.startsWith('--country=')) {
      const raw = arg.replace('--country=', '').trim();
      const mapped = mapCountryArg(raw);
      if (!mapped) {
        console.error(`❌ Unknown country: "${raw}"`);
        process.exit(1);
      }
      countries.push(mapped);
    }
  }

  if (countries.length === 0) {
    console.error('Usage: pnpm corpus:inventory --country=<name> | --all');
    process.exit(1);
  }

  return { countries };
}

function mapCountryArg(raw: string): Country | null {
  const map: Record<string, Country> = {
    kenya: 'Kenya',
    international: 'International',
    malawi: 'Malawi',
    nigeria: 'Nigeria',
    rwanda: 'Rwanda',
  };
  return map[raw.toLowerCase()] ?? null;
}

// ============================================================================
// Counting Helpers
// ============================================================================

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

// ============================================================================
// Inventory Report
// ============================================================================

interface InventoryReport {
  totalEntries: number;
  approvedEntries: number;
  placeholderEntries: number;
  needsReviewEntries: number;
  rejectedEntries: number;
  supersededEntries: number;
  missingFiles: string[];
  missingSourceUrls: number;
  missingChecksums: number;
  categoryCounts: Record<string, number>;
  countryCounts: Record<string, number>;
  authorityStatusCounts: Record<string, number>;
  documentTypeCounts: Record<string, number>;
  priorityCounts: Record<string, number>;
}

function buildReport(results: ManifestLoadResult[]): InventoryReport {
  const allEntries: CorpusManifestEntry[] = [];

  for (const result of results) {
    allEntries.push(...result.validEntries);
  }

  const missingFiles: string[] = [];
  for (const entry of allEntries) {
    const abs = resolveLocalPath(entry.localPath);
    if (!abs || !fs.existsSync(abs)) {
      missingFiles.push(`[${entry.id}] ${entry.localPath}`);
    }
  }

  return {
    totalEntries: allEntries.length,
    approvedEntries: allEntries.filter((e) => e.reviewStatus === 'APPROVED').length,
    placeholderEntries: allEntries.filter((e) => e.reviewStatus === 'PLACEHOLDER').length,
    needsReviewEntries: allEntries.filter((e) => e.reviewStatus === 'NEEDS_REVIEW').length,
    rejectedEntries: allEntries.filter((e) => e.reviewStatus === 'REJECTED').length,
    supersededEntries: allEntries.filter((e) => e.reviewStatus === 'SUPERSEDED').length,
    missingFiles,
    missingSourceUrls: allEntries.filter((e) => !e.sourceUrl).length,
    missingChecksums: allEntries.filter((e) => !e.checksumSha256).length,
    categoryCounts: countBy(allEntries, (e) => e.category),
    countryCounts: countBy(allEntries, (e) => e.country),
    authorityStatusCounts: countBy(allEntries, (e) => e.authorityStatus),
    documentTypeCounts: countBy(allEntries, (e) => e.documentType),
    priorityCounts: countBy(allEntries, (e) => e.priority),
  };
}

// ============================================================================
// Printer
// ============================================================================

function printReport(report: InventoryReport): void {
  const divider = '═'.repeat(60);
  const thin = '─'.repeat(60);

  console.log(`\n${divider}`);
  console.log('📊 CORPUS INVENTORY REPORT');
  console.log(divider);

  console.log(`\nTotal entries:        ${report.totalEntries}`);
  console.log(`  ✅ Approved:        ${report.approvedEntries}`);
  console.log(`  🔍 Needs review:    ${report.needsReviewEntries}`);
  console.log(`  📦 Placeholder:     ${report.placeholderEntries}`);
  console.log(`  🚫 Rejected:        ${report.rejectedEntries}`);
  console.log(`  ⏳ Superseded:      ${report.supersededEntries}`);

  console.log(`\n${thin}`);
  console.log('📁 File Status');
  console.log(thin);
  console.log(`  Missing files:      ${report.missingFiles.length}`);
  console.log(`  Missing source URLs: ${report.missingSourceUrls}`);
  console.log(`  Missing checksums:   ${report.missingChecksums}`);

  if (report.missingFiles.length > 0) {
    console.log('\n  Missing files:');
    for (const f of report.missingFiles) {
      console.log(`    ⚠️  ${f}`);
    }
  }

  console.log(`\n${thin}`);
  console.log('🌍 By Country');
  console.log(thin);
  printCounts(report.countryCounts);

  console.log(`\n${thin}`);
  console.log('📂 By Category');
  console.log(thin);
  printCounts(report.categoryCounts);

  console.log(`\n${thin}`);
  console.log('📜 By Authority Status');
  console.log(thin);
  printCounts(report.authorityStatusCounts);

  console.log(`\n${thin}`);
  console.log('📄 By Document Type');
  console.log(thin);
  printCounts(report.documentTypeCounts);

  console.log(`\n${thin}`);
  console.log('🎯 By Priority');
  console.log(thin);
  printCounts(report.priorityCounts);

  console.log(`\n${divider}\n`);
}

function printCounts(counts: Record<string, number>): void {
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  for (const [key, value] of sorted) {
    console.log(`  ${key.padEnd(28)} ${value}`);
  }
}

// ============================================================================
// Main
// ============================================================================

function main(): void {
  const { countries } = parseArgs();

  console.log('\n📦 SheriaBot — Corpus Inventory Reporter\n');
  console.log(`Countries: ${countries.join(', ')}`);

  const results = countries.map((c) => loadManifest(c));

  // Print per-country summaries
  for (const result of results) {
    const thin = '─'.repeat(40);
    console.log(`\n${thin}`);
    console.log(`📋 ${result.country}: ${result.validEntries.length} entries`);
    if (result.errors.length > 0) {
      console.log(`   ❌ ${result.errors.length} error(s)`);
    }
    if (result.warnings.length > 0) {
      console.log(`   ⚠️  ${result.warnings.length} warning(s)`);
    }
  }

  // Aggregate report
  const report = buildReport(results);
  printReport(report);
}

main();
