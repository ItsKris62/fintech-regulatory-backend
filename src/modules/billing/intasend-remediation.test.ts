import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../..');

function src(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('IntaSend billing remediation invariants', () => {
  const finalizer = src('src/modules/billing/intasend-finalization.service.ts');
  const renewal = src('src/modules/billing/mpesa-renewal.service.ts');
  const billingRouter = src('src/server/routers/billing.router.ts');
  const paymentRouter = src('src/server/routers/payment.router.ts');
  const adminRouter = src('src/server/routers/admin.router.ts');
  const adminModule = src('src/modules/admin/admin.module.ts');
  const webhook = src('src/lib/intasend/webhook.service.ts');
  const schema = src('prisma/schema.prisma');

  it('centralizes completed IntaSend payment finalization in an atomic transaction', () => {
    expect(finalizer).toContain('class IntaSendFinalizationService');
    expect(finalizer).toContain('async finalizePayment');
    expect(finalizer).toContain('await prisma.$transaction');
    expect(finalizer).toContain('tx.payment.updateMany');
    expect(finalizer).toContain('where: { id: payment.id, status: PaymentStatus.PENDING }');
    expect(finalizer).toContain('status: PaymentStatus.COMPLETED');
    expect(finalizer).toContain('plan: purchasedPlan');
    expect(finalizer).toContain('subscriptionTier: purchasedPlan');
    expect(finalizer).toContain('preferredPaymentMethod: PaymentProvider.MPESA');
  });

  it('uses Payment.subscriptionPlan and preserves the existing invoice number', () => {
    expect(finalizer).toContain('payment.subscriptionPlan');
    expect(finalizer).not.toContain('org.plan as SubscriptionPlan');
    expect(finalizer).toContain('invoiceNumber: payment.invoiceNumber');
  });

  it('rejects amount or currency mismatches before activating subscriptions', () => {
    expect(finalizer).toContain("reason: 'amount_mismatch'");
    expect(finalizer).toContain("reason: 'currency_mismatch'");
    expect(finalizer).toContain('payment_finalization_rejected');
  });

  it('reuses the finalizer from webhook and polling recovery paths', () => {
    expect(webhook).toContain('intaSendFinalizationService.finalizePayment');
    expect(webhook).not.toContain('subscriptionStatus:     SubscriptionStatus.ACTIVE');
    expect(billingRouter).toContain('source: \'polling\'');
    expect(billingRouter).toContain('intaSendFinalizationService.finalizePayment');
  });

  it('guards plan-changing billing mutations to organization owners/admins and disables Stripe centrally', () => {
    expect(billingRouter).toContain('const billingAdminProcedure = orgMemberProcedureWithRole([MemberRole.ADMIN, MemberRole.OWNER])');
    expect(billingRouter).toContain('createCheckoutSession: billingAdminProcedure');
    expect(billingRouter).toContain('updatePaymentMethod: billingAdminProcedure');
    expect(billingRouter).toContain('initiateMpesaPayment: billingAdminProcedure');
    expect(billingRouter).toContain('assertStripeEnabled()');
  });

  it('adds payment lifecycle and provider transaction database integrity', () => {
    expect(schema).toContain('EXPIRED');
    expect(schema).toContain('@@unique([provider, providerTransactionId])');
  });

  it('implements a manual M-Pesa renewal lifecycle without silent recurring charges', () => {
    expect(renewal).toContain('REMINDER_WINDOWS_DAYS = [7, 3, 1, 0]');
    expect(renewal).toContain('sendPaymentDueEmail');
    expect(renewal).toContain('subscriptionStatus: SubscriptionStatus.PAST_DUE');
    expect(renewal).toContain('subscriptionStatus: SubscriptionStatus.EXPIRED');
    expect(renewal).toContain('plan: SubscriptionPlan.REGULATOR');
    expect(renewal).toContain('invalidateOrganizationPlanCaches(org.id)');
    expect(renewal).toContain("action: 'renewal_reminder_sent'");
    expect(renewal).not.toContain('initiateMpesaPayment');
    expect(renewal).not.toContain('collection.mpesaStkPush');
    expect(billingRouter).toContain("paymentPurpose:   z.enum([PAYMENT_PURPOSE_INITIAL, PAYMENT_PURPOSE_RENEWAL])");
    expect(billingRouter).toContain("paymentKind: paymentPurpose === PAYMENT_PURPOSE_RENEWAL ? 'renewal' : 'initial_purchase'");
  });

  it('repairs billing reporting contracts and KES unit normalization', () => {
    expect(paymentRouter).toContain('invoiceNumber:');
    expect(paymentRouter).toContain('subscriptionPlan:');
    expect(paymentRouter).toContain('billingPeriodStart:');
    expect(paymentRouter).toContain('billingPeriodEnd:');
    expect(billingRouter).toContain('mpesaPhoneNumber');
    expect(billingRouter).toContain('catalogPrice');
    expect(adminRouter).toContain('const toKes = (amount: number | null | undefined) => Math.round((Number(amount ?? 0) / 100) * 100) / 100');
    expect(adminRouter).toContain('totalRevenueLast30Days: toKes(');
    expect(adminRouter).toContain('amount: toKes(p.amount)');
  });

  it('uses Organization.plan as authoritative admin subscription reporting source', () => {
    expect(adminModule).toContain('select: { plan: true, subscriptionStatus: true }');
    expect(adminModule).toContain('const plan = String(org.plan)');
    expect(adminModule).not.toContain('groupBy({\n      by: [\'subscriptionTier\']');
  });
});
