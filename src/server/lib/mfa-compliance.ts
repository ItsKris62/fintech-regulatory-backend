/**
 * Central MFA compliance helper.
 * Evaluates whether a user satisfies MFA requirements (TOTP enrolled or Passkey registered).
 */
export function userSatisfiesMfa(user?: { totpEnabled?: boolean; hasPasskey?: boolean } | null): boolean {
  return Boolean(user?.totpEnabled || user?.hasPasskey);
}
