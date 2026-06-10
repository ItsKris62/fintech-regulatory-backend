/**
 * Corpus Manifest Validator (CLI)
 *
 * Validates one or all country manifests and reports errors/warnings.
 *
 * Usage:
 *   pnpm corpus:validate --country=kenya
 *   pnpm corpus:validate --country=international
 *   pnpm corpus:validate --country=malawi
 *   pnpm corpus:validate --country=nigeria
 *   pnpm corpus:validate --all
 */

import fs from 'fs';

import {
  loadManifest,
  getKnownCountries,
  resolveLocalPath,
  type ManifestLoadResult,
} from './manifest-loader';
import { computeFileSha256 } from './checksum';
import type { Country } from './manifest.schema';

// ============================================================================
// CLI Argument Parsing
// ============================================================================

function parseArgs(): { countries: Country[]; verifyChecksums: boolean } {
  const args = process.argv.slice(2);
  let countries: Country[] = [];
  let verifyChecksums = false;

  for (const arg of args) {
    if (arg === '--all') {
      countries = getKnownCountries();
    } else if (arg.startsWith('--country=')) {
      const raw = arg.replace('--country=', '').trim();
      const mapped = mapCountryArg(raw);
      if (!mapped) {
        console.error(`❌ Unknown country: "${raw}"`);
        console.error(`   Valid: kenya, international, malawi, nigeria`);
        process.exit(1);
      }
      countries.push(mapped);
    } else if (arg === '--verify-checksums') {
      verifyChecksums = true;
    }
  }

  if (countries.length === 0) {
    console.error('Usage: pnpm corpus:validate --country=<name> | --all [--verify-checksums]');
    process.exit(1);
  }

  return { countries, verifyChecksums };
}

function mapCountryArg(raw: string): Country | null {
  const map: Record<string, Country> = {
    kenya: 'Kenya',
    international: 'International',
    malawi: 'Malawi',
    nigeria: 'Nigeria',
  };
  return map[raw.toLowerCase()] ?? null;
}

// ============================================================================
// Checksum Verification
// ============================================================================

async function verifyEntryChecksums(
  result: ManifestLoadResult,
): Promise<string[]> {
  const checksumErrors: string[] = [];

  if (!result.manifest) return checksumErrors;

  for (const entry of result.validEntries) {
    if (!entry.checksumSha256) continue;

    const absPath = resolveLocalPath(entry.localPath);
    if (!absPath || !fs.existsSync(absPath)) continue;

    try {
      const actual = await computeFileSha256(absPath);
      if (actual !== entry.checksumSha256) {
        checksumErrors.push(
          `[${entry.id}] Checksum mismatch: expected ${entry.checksumSha256}, got ${actual}`,
        );
      }
    } catch (err: any) {
      checksumErrors.push(
        `[${entry.id}] Checksum verification failed: ${err?.message ?? 'Unknown error'}`,
      );
    }
  }

  return checksumErrors;
}

// ============================================================================
// Report Printer
// ============================================================================

function printResult(result: ManifestLoadResult, checksumErrors: string[] = []): boolean {
  const divider = '─'.repeat(60);

  console.log(`\n${divider}`);
  console.log(`📋 ${result.country}`);
  console.log(divider);

  if (result.errors.length === 0 && checksumErrors.length === 0) {
    console.log(`✅ Valid — ${result.validEntries.length} entries passed`);
  } else {
    console.log(`❌ ${result.errors.length + checksumErrors.length} error(s)`);
  }

  if (result.warnings.length > 0) {
    console.log(`⚠️  ${result.warnings.length} warning(s)`);
  }

  // Errors
  for (const err of result.errors) {
    const prefix = err.entryId ? `[${err.entryId}]` : '[manifest]';
    const field = err.field ? ` (${err.field})` : '';
    console.log(`  ❌ ${prefix}${field}: ${err.message}`);
  }

  for (const err of checksumErrors) {
    console.log(`  ❌ ${err}`);
  }

  // Warnings
  for (const warn of result.warnings) {
    console.log(`  ⚠️  ${warn}`);
  }

  const hasErrors = result.errors.length > 0 || checksumErrors.length > 0;
  return !hasErrors;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const { countries, verifyChecksums } = parseArgs();

  console.log('\n🔍 SheriaBot — Corpus Manifest Validator\n');
  console.log(`Countries: ${countries.join(', ')}`);
  console.log(`Checksum verification: ${verifyChecksums ? 'ON' : 'OFF'}`);

  let allPassed = true;

  for (const country of countries) {
    const result = loadManifest(country);

    let checksumErrors: string[] = [];
    if (verifyChecksums) {
      checksumErrors = await verifyEntryChecksums(result);
    }

    const passed = printResult(result, checksumErrors);
    if (!passed) allPassed = false;
  }

  const divider = '═'.repeat(60);
  console.log(`\n${divider}`);
  if (allPassed) {
    console.log('✅ ALL MANIFESTS VALID');
  } else {
    console.log('❌ VALIDATION FAILED — see errors above');
  }
  console.log(`${divider}\n`);

  process.exit(allPassed ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('💥 Fatal error:', (err as Error).message);
  process.exit(1);
});
