/**
 * IntaSend Service
 *
 * Wraps the intasend-node SDK for M-Pesa STK push payments.
 *
 * Webhook security note:
 *   The intasend-node SDK has no built-in webhook signature verification.
 *   On webhook receipt we re-call collection.status(invoice_id) to confirm
 *   the reported state directly from IntaSend's API before acting on it.
 *   This is more reliable than trusting the webhook payload alone because
 *   it goes back to the authoritative source.
 */

import { appConfig } from '@/config/app.config';
import { logger } from '@/utils/logger';
import { AppError } from '@/utils/error';
import {
  type STKPushInput,
  type STKPushResponse,
  type PaymentStatusResponse,
  normaliseIntaSendState,
} from './intasend.types';

// ---------------------------------------------------------------------------
// SDK instance (lazy singleton)
// intasend-node is CommonJS — require() is appropriate here
// ---------------------------------------------------------------------------

interface IntaSendCollection {
  mpesaStkPush(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  status(invoiceId: string, checkoutId?: string, signature?: string): Promise<Record<string, unknown>>;
}

interface IntaSendSDK {
  collection(): IntaSendCollection;
}

type IntaSendConstructor = new (publishableKey: string, secretKey: string, testMode: boolean) => IntaSendSDK;

let _sdk: IntaSendSDK | null = null;

function getSDK(): IntaSendSDK {
  if (_sdk) return _sdk;

  const { publishableKey, secretKey, isTest } = appConfig.intasend;

  if (!publishableKey || !secretKey) {
    throw new AppError(
      500,
      'INTASEND_NOT_CONFIGURED',
      'IntaSend API keys are not configured. Set INTASEND_PUBLISHABLE_KEY and INTASEND_SECRET_KEY.',
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const IntaSend = require('intasend-node') as IntaSendConstructor;
  _sdk = new IntaSend(publishableKey, secretKey, isTest);
  return _sdk;
}

// ---------------------------------------------------------------------------
// Phone number normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise a Kenyan phone number to the 254XXXXXXXXX format.
 *
 * Accepts:
 *   07XX XXX XXX  ->  2547XXXXXXXX
 *   01XX XXX XXX  ->  2541XXXXXXXX
 *   +254XXXXXXXXX ->  254XXXXXXXXX
 *   254XXXXXXXXX  ->  254XXXXXXXXX (already valid)
 *
 * Returns null if the number cannot be normalised.
 */
export function normalisePhoneNumber(raw: string): string | null {
  // Strip spaces, dashes, parentheses
  const stripped = raw.replace(/[\s\-()]/g, '');

  let normalised = stripped;

  // Remove leading +
  if (normalised.startsWith('+')) {
    normalised = normalised.slice(1);
  }

  // Convert 07XX or 01XX prefix
  if (/^0[71]\d{8}$/.test(normalised)) {
    normalised = '254' + normalised.slice(1);
  }

  // Must be 254 followed by exactly 9 digits (total 12)
  if (/^254\d{9}$/.test(normalised)) {
    return normalised;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Service methods
// ---------------------------------------------------------------------------

class IntaSendService {
  /**
   * Initiate an M-Pesa STK push.
   *
   * @param input - phoneNumber (254XXXXXXXXX), amount in KES (whole number,
   *                NOT cents), accountReference, and narrative.
   * @returns invoiceId for status polling + raw response for metadata storage.
   */
  async initiateSTKPush(input: STKPushInput): Promise<STKPushResponse> {
    const sdk = getSDK();

    // Mask phone for logging — show only last 4 digits
    const maskedPhone = `254*****${input.phoneNumber.slice(-4)}`;

    logger.info({
      type:             'intasend_stk_push_initiating',
      phoneNumber:      maskedPhone,
      amount:           input.amount,
      accountReference: input.accountReference,
      isTest:           appConfig.intasend.isTest,
    });

    let raw: Record<string, unknown>;
    try {
      raw = await sdk.collection().mpesaStkPush({
        phone_number:      input.phoneNumber,
        amount:            input.amount,
        narrative:         input.narrative,
        account_reference: input.accountReference,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({
        type:             'intasend_stk_push_failed',
        phoneNumber:      maskedPhone,
        amount:           input.amount,
        accountReference: input.accountReference,
        error:            message,
      });
      throw new AppError(502, 'MPESA_INITIATION_FAILED', `M-Pesa payment initiation failed: ${message}`);
    }

    const invoiceId = ((raw['invoice_id'] ?? raw['id'] ?? '') as string);
    if (!invoiceId) {
      logger.error({ type: 'intasend_stk_push_no_invoice_id', raw });
      throw new AppError(502, 'MPESA_NO_INVOICE_ID', 'IntaSend did not return an invoice ID.');
    }

    const state = normaliseIntaSendState((raw['state'] as string) ?? 'PENDING');

    logger.info({
      type:             'intasend_stk_push_initiated',
      invoiceId,
      state,
      phoneNumber:      maskedPhone,
      amount:           input.amount,
      accountReference: input.accountReference,
    });

    return { invoiceId, state, raw };
  }

  /**
   * Check the current status of a payment by its IntaSend invoice ID.
   *
   * Called both by the frontend polling endpoint and by the webhook handler
   * to re-verify the reported state before acting on it.
   */
  async getPaymentStatus(invoiceId: string): Promise<PaymentStatusResponse> {
    const sdk = getSDK();

    let raw: Record<string, unknown>;
    try {
      raw = await sdk.collection().status(invoiceId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ type: 'intasend_status_check_failed', invoiceId, error: message });
      throw new AppError(502, 'MPESA_STATUS_CHECK_FAILED', `Failed to check M-Pesa payment status: ${message}`);
    }

    // The SDK wraps the response body in an `invoice` key
    const invoice = (raw['invoice'] ?? raw) as Record<string, unknown>;
    const state = normaliseIntaSendState((invoice['state'] as string) ?? 'PENDING');
    const providerRef = (invoice['mpesa_reference'] ?? invoice['provider_ref'] ?? null) as string | null;

    logger.info({ type: 'intasend_status_checked', invoiceId, state, providerRef });

    return { invoiceId, state, providerRef, raw: invoice };
  }
}

export const intaSendService = new IntaSendService();
export { IntaSendService };
