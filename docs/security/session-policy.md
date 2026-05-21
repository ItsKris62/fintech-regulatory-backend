# SheriaBot Session Policy

Date: 2026-05-21

## Current State

SheriaBot uses Supabase Auth access tokens at the API boundary, with application
session metadata stored in Prisma and short-lived request context cached in
Upstash Redis.

Current behavior:

- No concurrent-session cap is currently enforced.
- Login creates a new `Session` row when possible.
- Logout blocklists the presented JWT ID before best-effort cleanup.
- `SESSION_FINGERPRINT_MODE` is global and defaults to `monitor`.
- ADMIN users are now treated as `enforce` for fingerprint mismatches, regardless
  of the global setting.
- REGULATOR, STARTUP, and ENTERPRISE users continue to use the global
  `SESSION_FINGERPRINT_MODE`.

## Fingerprint Modes

`off`: fingerprint checks are skipped.

`monitor`: mismatches are logged for investigation, but the request is allowed.

`enforce`: mismatches blocklist the token and reject the request.

## Token Revocation

Token revocation has two maintained key paths. When a Supabase access token
contains a `jti` claim, logout and fingerprint enforcement write the JTI
blocklist key. When a token has no `jti`, logout writes a SHA-256 token-hash
fallback key instead. Request context checks both mechanisms, so future
revocation changes must preserve both paths.

## Per-Role Recommendations

ADMIN:

- Recommended fingerprint mode: `enforce`.
- Current implementation: enforced.
- Rationale: ADMIN sessions can affect users, organizations, billing, content,
  and security posture.

REGULATOR:

- Recommended fingerprint mode: `enforce`.
- Current implementation: follows global mode.
- Rationale: regulator accounts may access sensitive compliance posture, but
  enforcement rollout should follow ADMIN observation data.

STARTUP and ENTERPRISE:

- Recommended fingerprint mode: `monitor`.
- Current implementation: follows global mode.
- Rationale: these users may have legitimate multi-device workflows during the
  pilot period.

## Concurrent Sessions

No hard concurrent-session cap is enforced in this sprint.

Recommended future posture:

- ADMIN: strict cap after trusted-device UX exists.
- REGULATOR: strict or low cap after false-positive review.
- STARTUP and ENTERPRISE: product-defined cap based on expected team usage.

Open product decisions:

- Whether oldest sessions should be kicked automatically.
- Whether users should receive session-revocation notifications.
- Whether admins should see and revoke active sessions manually.

## Trusted Devices

Trusted devices are deferred.

Future work should define:

- Device enrollment and expiration.
- User-facing device naming.
- Admin revocation.
- Audit events for trust, revocation, and suspicious reuse.
