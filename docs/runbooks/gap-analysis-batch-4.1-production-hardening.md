# Gap Analysis Batch 4.1 production hardening

## Legacy AiJob payload cleanup

New `GAP_ANALYSIS_PIPELINE` writes contain an internal R2 reference and metadata, not raw document fields. This does not prove historical rows are clean.

Run the count-only audit first:

```bash
pnpm gap-analysis:cleanup-legacy-payloads
```

The command is dry-run by default, filters to `type=GAP_ANALYSIS_PIPELINE` and `targetEntityType=GapAnalysis`, and never prints payload values. It detects the historical fields `fileContent`, `base64`, `fileBuffer`, and `rawText`.

Compatibility policy:

- `QUEUED`, `RUNNING`, and `RETRYING` payloads are retained. The current compatibility path can resume only a `fileContent` payload; active rows containing only `base64`, `fileBuffer`, or `rawText` require manual triage and are reported separately rather than being guessed safe.
- `COMPLETED`, `FAILED`, `DEAD_LETTERED`, and `CANCELLED` payloads are terminal and safe to scrub.
- Unknown statuses are retained conservatively.
- Execution is idempotent and each batch is transactional. A content-free `GAP_ANALYSIS_LEGACY_PAYLOAD_CLEANUP` audit record summarizes an executed run.
- Production execution requires explicit approval and both `--execute --confirm-production`; it is never part of startup or deployment.

Historical acknowledgement records are immutable. New requests either omit `consentVersion` or send the current version as a stale-client check. The server always records its own canonical version and rejects a mismatched incoming version with `CONFLICT`.

## ClamAV deployment gate

Code speaks ClamAV `INSTREAM` for scans and `PING` for content-free readiness. Readiness is `READY` only after a `PONG`; configuration alone is not health evidence. Production Gap Analysis uploads fail closed if scanning is disabled, unconfigured, unreachable, or errors.

The repository does not provision a ClamAV daemon. Before production release, operations must:

1. Provision an operator-owned ClamAV service reachable from the Render backend over a private or otherwise strictly isolated network path.
2. Set `MALWARE_SCAN_ENABLED=true`, `CLAMAV_HOST`, `CLAMAV_PORT` (normally 3310), and the timeout in the Render service. Do not expose the unauthenticated ClamAV TCP port publicly.
3. Assign patching, signature updates, capacity monitoring, restart policy, and incident ownership. Measure memory/CPU with the chosen image and traffic; this repository contains no verified resource sizing.
4. Ensure the scanner starts and becomes reachable before enabling customer uploads. The API remains diagnosable when it is unavailable, but uploads fail closed.
5. Verify authenticated detailed health reports `READY`, then run clean, EICAR, and unavailable-scanner smokes from the application network.

Current Render configuration defines the application variables only. Scanner hostname, hosting service, network attachment, restart behavior, and live capacity are deployment responsibilities and are not verified by code tests.

## Cancellation state machine

Deletion first writes `GapAnalysis.status=CANCELLED`, then cancels `QUEUED`, `RUNNING`, or `RETRYING` AiJobs. Workers check analysis/job state before and after retrieval, before and after extraction, before each provider operation, before verification, and before the conditional final write. Supported provider requests receive an `AbortSignal`. If a request has already reached a provider it may still finish remotely, but its result is discarded and no later provider call or final result write is permitted.

The final result update requires `deletedAt IS NULL` and `status != CANCELLED`; the job completion update separately requires the job still be `RUNNING`.

## Retention state reality and product decision

`GapAnalysisLifecycleState` is a TypeScript type, not a database column. Operationally, `deletedAt IS NULL` is active and `deletedAt IS NOT NULL` is deleted. During deletion, `status=CANCELLED` prevents worker progress before `deletedAt` is finalized, but there is no durable `PENDING_DELETION` state. No migration was added.

`RETENTION_DURATION = PRODUCT/LEGAL DECISION REQUIRED`.

| Option | Security/privacy implication | Customer convenience | Storage cost | Operational complexity |
| --- | --- | --- | --- | --- |
| Delete shortly after completion | Minimizes policy retention and breach exposure | Lowest ability to revisit/re-export | Lowest | Requires prompt purge and clear customer notice |
| 30 days | Short bounded exposure | Short revisit window | Low | Scheduled purge and support policy |
| 90 days | Longer exposure window | Longer revisit window | Medium | Scheduled purge and more deletion/DSR coverage |
| Customer-controlled | Can match customer policy if bounded and enforced | Highest flexibility | Variable | Highest: controls, defaults, limits, audit, purge enforcement |

These are options, not an implementation decision.

## Upload transport and storage semantics

The browser still reads the full file into a data URL and sends base64 in tRPC JSON. A 10 MiB binary expands to about 13.33 MiB before JSON framing, while browser and backend can temporarily hold both encoded and decoded copies. Proxy/body limits were not measured.

`document.getUploadUrl` / `document.confirmUpload` are not safe drop-in Gap Analysis primitives: their tenant path and `LegalDocument` semantics differ, their allowlist includes formats outside the Gap Analysis contract, confirmation validates only an initial chunk, and that router does not perform the full Gap Analysis validation/scanner/lifecycle sequence. A post-release transition should reuse the underlying presign/storage primitives behind Gap Analysis-specific prepare/confirm procedures rather than create another generic uploader.

`GapAnalysis.documentUrl` currently stores a private internal R2 key. The worker and deletion path are the only raw readers. The result endpoint replaces it with `gap-analysis:<analysisId>`, and list responses do not select it. No public or signed URL semantics remain for this field.

## Canonical forensic finding IDs

- GA-01 benchmark entitlement
- GA-02 multi-jurisdiction execution
- GA-03 generic evidence relabelling
- GA-04 finding-level citation lineage
- GA-05 durable base64 payload retention
- GA-06 depth entitlement mismatch
- GA-07 upload contract mismatch
- GA-08 Quick/Standard/Deep execution-depth weakness
- GA-09 scoring methodology
- GA-10 international evidence exclusion
- GA-11 upload security / malware / OCR
- GA-12 report defensibility
- GA-13 skipped/failed chunk completeness
- GA-14 deduplication versioning / race
- GA-15 UX/accessibility/history
- GA-16 observability/cost accounting

Batch 4.1 lifecycle/deployment concerns remain in this Operational Hardening section; the original IDs are not renamed.
