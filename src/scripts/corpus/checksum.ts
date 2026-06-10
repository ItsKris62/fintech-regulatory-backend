/**
 * SHA-256 Checksum Utility
 *
 * Provides functions to compute and verify SHA-256 checksums for corpus
 * document files.
 */

import crypto from 'crypto';
import fs from 'fs';

/**
 * Compute the SHA-256 hex digest for a file at the given absolute path.
 */
export async function computeFileSha256(absolutePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absolutePath);

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => reject(err));
  });
}

/**
 * Verify that a file's SHA-256 matches the expected checksum.
 * Returns `{ match: true }` or `{ match: false, actual: string }`.
 */
export async function verifyChecksum(
  absolutePath: string,
  expectedSha256: string,
): Promise<{ match: boolean; actual: string }> {
  const actual = await computeFileSha256(absolutePath);
  return {
    match: actual === expectedSha256,
    actual,
  };
}
