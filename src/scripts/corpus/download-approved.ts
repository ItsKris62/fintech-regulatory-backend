/**
 * Download Approved Candidates CLI
 *
 * Downloads only APPROVED candidates from candidate manifests, computes
 * checksums, and updates entries. Requires --approved-only flag.
 *
 * Usage:
 *   pnpm corpus:download --country=malawi --approved-only
 *   pnpm corpus:download --country=nigeria --approved-only
 *   pnpm corpus:download --all --approved-only
 *   pnpm corpus:download --country=malawi --approved-only --dry-run
 *   pnpm corpus:download --country=malawi --approved-only --force
 *
 * Phase 3 — download only. Does not ingest or modify production manifests.
 */

import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

import {
  loadCandidateManifest,
  writeCandidateManifest,
  getDownloadReportPath,
  writeReport,
} from './candidate-loader';

import { computeFileSha256 } from './checksum';
import { generateDownloadReport } from './discovery-report';

import type { CandidateEntry, CandidateCountry } from './candidate.schema';

// ============================================================================
// CLI Arg Parsing
// ============================================================================

function parseArgs(): {
  countries: CandidateCountry[];
  approvedOnly: boolean;
  dryRun: boolean;
  force: boolean;
} {
  const args = process.argv.slice(2);

  let countries: CandidateCountry[] = [];
  let approvedOnly = false;
  let dryRun = false;
  let force = false;

  for (const arg of args) {
    if (arg === '--all') {
      countries = ['Malawi', 'Nigeria'];
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
    } else if (arg === '--approved-only') {
      approvedOnly = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--force') {
      force = true;
    }
  }

  if (countries.length === 0) {
    console.error('Usage: pnpm corpus:download --country=<name> | --all --approved-only [--dry-run] [--force]');
    process.exit(1);
  }

  if (!approvedOnly) {
    console.error('❌ Safety: --approved-only flag is required. Refusing to download without it.');
    process.exit(1);
  }

  return { countries, approvedOnly, dryRun, force };
}

// ============================================================================
// Download Engine
// ============================================================================

function getProjectRoot(): string {
  return path.resolve(__dirname, '..', '..', '..');
}

/**
 * Download a single file from a URL to a local path.
 */
async function downloadFile(
  url: string,
  destPath: string,
): Promise<{ contentType: string | null }> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'SheriaBot-Corpus-Downloader/1.0',
    },
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type');

  // Ensure directory exists
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Stream response body to file
  if (!response.body) {
    throw new Error('Response body is null');
  }

  const readable = Readable.fromWeb(response.body as any);
  const writable = fs.createWriteStream(destPath);
  await pipeline(readable, writable);

  return { contentType };
}

/**
 * Validate that a proposed local path is safe (no traversal, under documents/).
 */
function isPathSafe(localPath: string): boolean {
  if (localPath.includes('..')) return false;
  if (!localPath.startsWith('documents/')) return false;
  if (/^[A-Za-z]:/.test(localPath)) return false;
  if (localPath.startsWith('/')) return false;
  if (localPath.includes('\\')) return false;
  return true;
}

async function downloadCountry(
  country: CandidateCountry,
  dryRun: boolean,
  force: boolean,
): Promise<{
  downloaded: CandidateEntry[];
  skipped: CandidateEntry[];
  failed: Array<{ entry: CandidateEntry; error: string }>;
}> {
  const downloaded: CandidateEntry[] = [];
  const skipped: CandidateEntry[] = [];
  const failed: Array<{ entry: CandidateEntry; error: string }> = [];

  const loadResult = loadCandidateManifest(country);
  if (loadResult.errors.length > 0) {
    console.error(`❌ Candidate manifest errors for ${country}:`);
    for (const err of loadResult.errors) {
      console.error(`  - ${err}`);
    }
    return { downloaded, skipped, failed };
  }

  if (loadResult.entries.length === 0) {
    console.log(`  ℹ️  No candidates for ${country}`);
    return { downloaded, skipped, failed };
  }

  const projectRoot = getProjectRoot();

  for (const entry of loadResult.entries) {
    if (entry.decision !== 'APPROVED') {
      skipped.push(entry);
      continue;
    }

    if (!entry.proposedLocalPath) {
      failed.push({ entry, error: 'No proposedLocalPath set' });
      continue;
    }

    if (!isPathSafe(entry.proposedLocalPath)) {
      failed.push({ entry, error: `Unsafe path: "${entry.proposedLocalPath}"` });
      continue;
    }

    const destAbsolute = path.resolve(projectRoot, entry.proposedLocalPath);

    // Check if file already exists
    if (fs.existsSync(destAbsolute) && !force) {
      console.log(`  ⏩ Already exists (use --force to overwrite): ${entry.proposedLocalPath}`);
      // Still count as "downloaded" if it's there already
      if (!entry.downloadedLocalPath) {
        entry.downloadedLocalPath = entry.proposedLocalPath;
      }
      downloaded.push(entry);
      continue;
    }

    if (dryRun) {
      console.log(`  ⏩ [DRY RUN] Would download: ${entry.sourceUrl}`);
      console.log(`     → ${entry.proposedLocalPath}`);
      downloaded.push(entry);
      continue;
    }

    // Actually download
    try {
      console.log(`  ⬇️  Downloading: ${entry.normalizedTitle}`);
      console.log(`     URL: ${entry.sourceUrl}`);
      console.log(`     → ${entry.proposedLocalPath}`);

      const { contentType } = await downloadFile(entry.sourceUrl, destAbsolute);

      // Compute checksum
      const checksum = await computeFileSha256(destAbsolute);

      // Update entry
      entry.downloadedLocalPath = entry.proposedLocalPath;
      entry.checksumSha256 = checksum;
      entry.contentType = contentType;

      downloaded.push(entry);
      console.log(`  ✅ Downloaded (SHA-256: ${checksum.slice(0, 16)}...)`);
    } catch (err: any) {
      const errMsg = err?.message ?? 'Unknown error';
      failed.push({ entry, error: errMsg });
      console.error(`  ❌ Failed: ${errMsg}`);
    }
  }

  return { downloaded, skipped, failed };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const { countries, dryRun, force } = parseArgs();

  console.log('\n⬇️  SheriaBot — Corpus Download (Approved Only)\n');
  console.log(`Countries: ${countries.join(', ')}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  if (force) console.log('Force: ON (will overwrite existing files)');

  let totalDownloaded = 0;
  let totalFailed = 0;

  for (const country of countries) {
    console.log(`\n────────────────────────────────────────────────────────────`);
    console.log(`📋 ${country}`);
    console.log(`────────────────────────────────────────────────────────────`);

    const { downloaded, skipped, failed } = await downloadCountry(
      country,
      dryRun,
      force,
    );

    totalDownloaded += downloaded.length;
    totalFailed += failed.length;

    console.log(`\n  Downloaded: ${downloaded.length}`);
    console.log(`  Skipped: ${skipped.length}`);
    console.log(`  Failed: ${failed.length}`);

    // Update candidate manifest with download results
    if (!dryRun) {
      const loadResult = loadCandidateManifest(country);
      if (loadResult.manifest) {
        // Update entries in-place with download results
        for (const dl of downloaded) {
          const existing = loadResult.manifest.entries.find((e) => e.id === dl.id);
          if (existing) {
            existing.downloadedLocalPath = dl.downloadedLocalPath;
            existing.checksumSha256 = dl.checksumSha256;
            existing.contentType = dl.contentType;
          }
        }
        writeCandidateManifest(country, loadResult.manifest);
      }
    }

    // Write download report
    const report = generateDownloadReport(
      country,
      downloaded,
      skipped,
      failed,
      dryRun,
    );

    if (!dryRun) {
      writeReport(getDownloadReportPath(country), report);
      console.log(`  ✅ Download report written`);
    } else {
      console.log(`  ⏩ [DRY RUN] Would write download report`);
    }
  }

  console.log('\n════════════════════════════════════════════════════════════');
  if (totalFailed > 0) {
    console.log(`⚠️  DOWNLOAD COMPLETED WITH ${totalFailed} FAILURE(S)`);
  } else {
    console.log(`✅ DOWNLOAD COMPLETED — ${totalDownloaded} file(s) processed`);
  }
  console.log('════════════════════════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('Fatal error during download:', err);
  process.exit(1);
});
