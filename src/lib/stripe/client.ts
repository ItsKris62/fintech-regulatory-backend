import Stripe from 'stripe';
import { appConfig } from '@/config/app.config';

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
export const stripe = new Stripe(appConfig.stripe.secretKey, {
  apiVersion: '2026-02-25.clover',
  typescript: true,
  // Telemetry is opt-out; disable to avoid sending usage data to Stripe
  telemetry: false,
});
