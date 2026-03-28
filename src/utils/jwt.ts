/**
 * Lightweight JWT claim extractors.
 *
 * We deliberately use `jsonwebtoken.decode` (no verification) here because:
 *  - Supabase has already cryptographically verified the token in context.ts
 *    via `supabaseAdmin.auth.getUser(token)` before these helpers are called.
 *  - We only need to read the JTI / IAT / EXP claims for revocation bookkeeping,
 *    not re-validate the signature.
 *
 * `jsonwebtoken` is already in package.json (^9.0.3 / @types/jsonwebtoken ^9.0.10).
 */

import jwt from 'jsonwebtoken';

type JwtPayload = jwt.JwtPayload;

function decodePayload(token: string): JwtPayload | null {
  try {
    const decoded = jwt.decode(token);
    if (decoded && typeof decoded === 'object') return decoded as JwtPayload;
    return null;
  } catch {
    return null;
  }
}

/** Extract the JWT ID (jti) claim. Returns null if absent or malformed. */
export function extractJti(token: string): string | null {
  return decodePayload(token)?.jti ?? null;
}

/** Extract the issued-at (iat) claim as a Unix second timestamp. */
export function extractIat(token: string): number | null {
  const iat = decodePayload(token)?.iat;
  return typeof iat === 'number' ? iat : null;
}

/** Extract the expiry (exp) claim as a Unix second timestamp. */
export function extractExp(token: string): number | null {
  const exp = decodePayload(token)?.exp;
  return typeof exp === 'number' ? exp : null;
}
