/**
 * WebAuthn (FIDO2 / Passkeys) Server Configuration
 */

export interface WebAuthnConfig {
  rpID: string;
  rpName: string;
  expectedOrigin: string;
}

export function getWebAuthnConfig(): WebAuthnConfig {
  const isProd = process.env.NODE_ENV === 'production';
  const rpID = process.env.WEBAUTHN_RP_ID || (!isProd ? 'localhost' : '');
  const rpName = process.env.WEBAUTHN_RP_NAME || 'Sheria Bot';
  const expectedOrigin = process.env.WEBAUTHN_EXPECTED_ORIGIN || (!isProd ? (process.env.FRONTEND_URL || 'http://localhost:3000') : '');

  if (isProd) {
    if (!process.env.WEBAUTHN_RP_ID) {
      throw new Error('[WebAuthn] Missing required environment variable in production: WEBAUTHN_RP_ID');
    }
    if (!process.env.WEBAUTHN_EXPECTED_ORIGIN) {
      throw new Error('[WebAuthn] Missing required environment variable in production: WEBAUTHN_EXPECTED_ORIGIN');
    }
  }

  return {
    rpID,
    rpName,
    expectedOrigin,
  };
}

export const webauthnConfig = getWebAuthnConfig();
