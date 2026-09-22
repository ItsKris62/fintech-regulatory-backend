/**
 * Redis Key Restoration Script
 * Restores Upstash Redis keys from a JSON snapshot created in ../sheriabot-backups/
 *
 * Usage:
 *   npx tsx scripts/restore-redis-keys.ts <path-to-json-snapshot>
 *   e.g.: npx tsx scripts/restore-redis-keys.ts ../sheriabot-backups/redis_keys_20260922_184004.json
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { redis } from '../src/lib/redis/client';

async function main() {
  const snapshotArg = process.argv[2];
  if (!snapshotArg) {
    console.error('❌ Please provide path to redis snapshot file.');
    console.log('Usage: npx tsx scripts/restore-redis-keys.ts <path-to-redis-snapshot.json>');
    process.exit(1);
  }

  const snapshotPath = path.resolve(process.cwd(), snapshotArg);
  if (!fs.existsSync(snapshotPath)) {
    console.error(`❌ Snapshot file not found: ${snapshotPath}`);
    process.exit(1);
  }

  const rawData = fs.readFileSync(snapshotPath, 'utf8');
  const keysData: Record<string, any> = JSON.parse(rawData);
  const keyList = Object.keys(keysData);

  console.log(`\n========================================`);
  console.log(`🔄 Upstash Redis Key Restoration`);
  console.log(`Snapshot: ${snapshotPath}`);
  console.log(`Total Keys: ${keyList.length}`);
  console.log(`========================================\n`);

  let restored = 0;
  let skipped = 0;

  for (const key of keyList) {
    const val = keysData[key];
    if (val === '[non-string or stream]' || val === null || val === undefined) {
      skipped++;
      continue;
    }

    try {
      if (typeof val === 'object') {
        await redis.set(key, JSON.stringify(val));
      } else {
        await redis.set(key, val);
      }
      restored++;
    } catch (err: any) {
      console.warn(`⚠️ Failed to restore key ${key}: ${err?.message}`);
    }
  }

  console.log(`\n✅ Redis restoration complete: ${restored} keys restored, ${skipped} skipped.`);
}

main().catch((err) => {
  console.error('❌ Restoration failed:', err);
  process.exit(1);
});
