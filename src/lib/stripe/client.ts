import Stripe from 'stripe';
import { appConfig } from '@/config/app.config';
import { AppError } from '@/utils/error';
import { executeWithBreaker } from '@/lib/circuit-breaker/circuit-breaker.service';

/**
 * Stripe SDK singleton with Circuit Breaker protection.
 *
 * Initialised once at startup using the STRIPE_SECRET_KEY env var.
 * Import this wherever you need to call Stripe APIs.
 */
let rawStripeClient: Stripe | null = null;
let wrappedStripeClient: Stripe | null = null;

function createStripeCircuitBreakerProxy(client: Stripe): Stripe {
  function wrap(obj: any): any {
    return new Proxy(obj, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === 'webhooks') return value; // Webhook crypto verification is local
        if (typeof value === 'function') {
          return (...args: any[]) => executeWithBreaker('stripe', () => value.apply(target, args));
        }
        if (typeof value === 'object' && value !== null) {
          return wrap(value);
        }
        return value;
      },
    });
  }
  return wrap(client);
}

export function getStripeClient(): Stripe {
  if (!appConfig.payments.stripeEnabled) {
    throw new AppError(400, 'STRIPE_DISABLED', 'Stripe billing is currently disabled.');
  }

  if (!appConfig.stripe.secretKey) {
    throw new AppError(500, 'STRIPE_NOT_CONFIGURED', 'Stripe is enabled but STRIPE_SECRET_KEY is not configured.');
  }

  if (!rawStripeClient) {
    rawStripeClient = new Stripe(appConfig.stripe.secretKey, {
      apiVersion: '2026-02-25.clover',
      typescript: true,
      telemetry: false,
      timeout: 10000,
      maxNetworkRetries: 2,
    });
    wrappedStripeClient = createStripeCircuitBreakerProxy(rawStripeClient);
  }

  return wrappedStripeClient ?? rawStripeClient;
}

