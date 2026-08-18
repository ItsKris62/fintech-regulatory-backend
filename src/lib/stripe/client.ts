import Stripe from 'stripe';
import { appConfig } from '@/config/app.config';
import { AppError } from '@/utils/error';

/**
 * Stripe SDK singleton.
 *
 * Initialised once at startup using the STRIPE_SECRET_KEY env var.
 * Import this wherever you need to call Stripe APIs.
 *
 * @example
 *   import { stripe } from '@/lib/stripe/client';
 *   const session = await stripe.checkout.sessions.create({ ... });
 */
let stripeClient: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (!appConfig.payments.stripeEnabled) {
    throw new AppError(400, 'STRIPE_DISABLED', 'Stripe billing is currently disabled.');
  }

  if (!appConfig.stripe.secretKey) {
    throw new AppError(500, 'STRIPE_NOT_CONFIGURED', 'Stripe is enabled but STRIPE_SECRET_KEY is not configured.');
  }

  if (!stripeClient) {
    stripeClient = new Stripe(appConfig.stripe.secretKey, {
      apiVersion: '2026-02-25.clover',
      typescript: true,
      // Telemetry is opt-out; disable to avoid sending usage data to Stripe
      telemetry: false,
    });
  }

  return stripeClient;
}
