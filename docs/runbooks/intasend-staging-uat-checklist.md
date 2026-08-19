# IntaSend Staging UAT Checklist

Use this checklist only against staging:

- Backend: `sheriabot-backend-staging`
- Backend branch: `staging/intasend-billing`
- Original backend billing remediation SHA: `290546bc2940f79c592c2f195398d88150165217`
- Backend post-security-remediation SHA: `3e59c196d3983fc0a2f36ad3f8ba3e26f1bb7754`
- Frontend branch: `staging/intasend-billing`
- Original frontend billing remediation SHA: `8df0740aeb51280b986f8c510d17c4a58606b77d`
- Frontend post-handoff SHA: `2e013f6106b9c85955cbd6c1a2ba700133b4c8ac`
- Database: Development-UAT only

Do not include secret values in screenshots, tickets, logs, or reports.

## T1 Render Proxy/IP Spoof Validation

- [ ] Setup: deploy backend staging with proxy trust disabled or `TRUST_PROXY_HOPS` blank.
- [ ] Setup: enable sanitized diagnostics for `request.ip`, `request.socket.remoteAddress`, `X-Forwarded-For` chain length, and `X-Real-IP` presence. Do not log auth headers, webhook challenge, or raw secret headers.
- [ ] Action: send a normal request through Render.
- [ ] Action: send request with `X-Forwarded-For: 1.2.3.4`.
- [ ] Action: send request with `X-Forwarded-For: 1.2.3.4, 5.6.7.8`.
- [ ] Action: send a multi-hop spoof attempt with several caller-controlled IPs.
- [ ] Expected result: caller-supplied IPs do not become the IP used by IntaSend allowlisting.
- [ ] DB evidence: none required unless diagnostics are persisted as audit events.
- [ ] Log/audit evidence: sanitized request diagnostics showing socket IP, forwarded chain structure, selected client IP, and rejected spoof.
- [ ] PASS criteria: actual safe `TRUST_PROXY_HOPS` is determined from runtime evidence, staging env is updated, and spoofed headers cannot bypass `INTASEND_WEBHOOK_ALLOWED_IPS`.

## T2 Controlled IntaSend Initial STK

- [ ] Setup: IntaSend sandbox/test credentials configured; `ACTIVE_PAYMENT_PROVIDER=INTASEND`; `STRIPE_ENABLED=false`.
- [ ] Setup: organization starts on free/regulator-equivalent plan.
- [ ] Action: initiate STARTUP purchase from deployed frontend.
- [ ] Expected result before payment: STK opens; no Stripe checkout or portal is invoked.
- [ ] DB evidence before payment: `Payment.status=PENDING`, `paymentPurpose=INITIAL_PURCHASE`, `subscriptionPlan=STARTUP`, correct amount/currency, `invoiceNumber` present, `providerTransactionId` present.
- [ ] Action: complete controlled sandbox/test STK.
- [ ] Expected result after payment: provider state is complete; webhook reaches backend; shared finalizer activates subscription.
- [ ] DB evidence after payment: `Payment.status=COMPLETED`, organization plan `STARTUP`, subscription status `ACTIVE`, dates correct, invoice number unchanged.
- [ ] Log/audit evidence: one payment completed event, one subscription activation event, one receipt event.
- [ ] PASS criteria: payment completes exactly once and all money/date fields match the runtime catalog.

## T3 Polling Missed-Webhook Recovery

- [ ] Setup: create a controlled pending IntaSend payment.
- [ ] Action: delay or suppress webhook delivery if sandbox tooling permits while provider state becomes complete.
- [ ] Action: trigger frontend/backend polling path.
- [ ] Expected result: local payment transitions `PENDING` to `COMPLETED` through provider polling and shared finalizer.
- [ ] DB evidence: one completed payment, one subscription activation or extension, one receipt.
- [ ] Action: deliver or replay the delayed webhook.
- [ ] Expected result: already-finalized outcome; no second period, no second receipt.
- [ ] Log/audit evidence: polling finalization, then idempotent webhook replay.
- [ ] PASS criteria: missed webhook is recovered by polling and replay is idempotent.

## T4 Reconciliation Cron Recovery

- [ ] Setup: create stale local `PENDING` payment where IntaSend provider state is complete.
- [ ] Action: run `npm run billing:intasend:reconcile` through the staging Render cron job/manual cron run.
- [ ] Expected result: payment finalizes once through reconciliation.
- [ ] DB evidence: no duplicate finalization, subscription extension, receipt, or revenue event.
- [ ] Action: run reconciliation a second time.
- [ ] Expected result: no state change except idempotent audit/log note.
- [ ] Log/audit evidence: reconciliation start, scanned/finalized counts, idempotent second run.
- [ ] PASS criteria: cron recovers missed webhook exactly once.

## T5 Customer-Confirmed Renewal

- [ ] Setup: Development-UAT organization is active on a paid plan with controlled renewal date.
- [ ] Action: run renewal lifecycle cron.
- [ ] Expected result: reminder/state lifecycle only; no unsolicited STK push and no silent debit.
- [ ] Action: customer clicks Renew with M-Pesa in deployed frontend.
- [ ] Expected result: STK opens only after customer action.
- [ ] DB evidence before payment: `paymentPurpose=RENEWAL`, current paid plan, backend catalog amount, billing period, stable invoice/reference.
- [ ] Action: complete controlled STK.
- [ ] DB evidence after payment: completed payment, subscription extended exactly once, prepaid time preserved, renewal counters reset, receipt emitted once.
- [ ] Action: replay completion.
- [ ] Expected result: no double extension.
- [ ] Log/audit evidence: customer initiation, webhook/poll finalization, replay idempotency.
- [ ] PASS criteria: renewal requires customer action and finalizes exactly once.

## T6 Admin Provider-Truth Expiry

- [ ] Setup A: local `PENDING`, provider `COMPLETE`.
- [ ] Action A: admin chooses Expire.
- [ ] Expected result A: system finalizes payment instead; must not expire.
- [ ] DB evidence A: payment completed, subscription updated once.
- [ ] Setup B: local `PENDING`, provider `PENDING`, old enough to expire.
- [ ] Action B: admin provides confirmation reason and expires.
- [ ] Expected result B: payment becomes `EXPIRED` if policy allows.
- [ ] DB evidence B: no subscription activation or extension.
- [ ] Setup C: provider lookup fails.
- [ ] Action C: admin attempts expire/reconcile.
- [ ] Expected result C: no destructive state change.
- [ ] Log/audit evidence: provider lookup result and admin action outcome for all scenarios.
- [ ] PASS criteria: admin expiry always respects provider truth and fails closed on lookup failure.

## T7 Vercel IntaSend-Only UI

- [ ] Setup: Vercel Preview is deployed from frontend SHA `8df0740aeb51280b986f8c510d17c4a58606b77d`.
- [ ] Setup: `NEXT_PUBLIC_API_URL` points to the Render staging backend `/trpc` endpoint.
- [ ] Action: fresh user starts STARTUP purchase.
- [ ] Expected result: M-Pesa/STK flow opens; no Stripe checkout.
- [ ] Action: fresh user starts BUSINESS purchase.
- [ ] Expected result: M-Pesa/STK flow opens; no Stripe checkout.
- [ ] Action: existing subscriber opens Manage Billing.
- [ ] Expected result: Stripe portal is not invoked when Stripe is disabled.
- [ ] Action: past-due subscriber clicks renewal CTA.
- [ ] Expected result: M-Pesa renewal flow opens.
- [ ] Action: admin opens billing operations.
- [ ] Expected result: pending IntaSend payments are visible; Reconcile exists; Expire requires confirmation/reason; no Force Paid or Mark Complete action exists.
- [ ] DB evidence: payment rows match initiated actions and no Stripe provider rows are created.
- [ ] Log/audit evidence: frontend calls hit staging Render backend and Development-UAT DB.
- [ ] PASS criteria: deployed UI is IntaSend-only and all payment/admin flows target staging backend.
