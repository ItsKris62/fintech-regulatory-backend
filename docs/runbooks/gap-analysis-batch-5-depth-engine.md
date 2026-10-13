# Gap Analysis Batch 5 depth engine

Execution profile version: `gap-analysis-depth-v2`.

Historical completed results without `metadata.executionProfileVersion` remain labelled `legacy execution profile`. They are not rewritten.

## Operational profiles

| Dimension | Quick | Standard | Deep |
| --- | ---: | ---: | ---: |
| Purpose | Material-risk screening | Balanced professional review | Enhanced investigative review |
| Queries per framework | 1 | 2 | 3 |
| Retrieval `topK` | 4 | 8 | 12 |
| Candidate multiplier | 2 | 2 | 2 |
| Similarity threshold | 0.65 | 0.60 | 0.60 |
| Weak-evidence retries | 0 | 1/framework, 4 total maximum | 1/framework, 5 total maximum |
| Accepted evidence/framework | 4 | 8 | 12 |
| Aggregate evidence ceiling | 40 | 80 | 120 |
| Chunk size/overlap | 8000/600 | 6000/800 | 6000/800 |
| Chunk ceiling | 4 sampled | 12 configured traversal | 20 enhanced traversal |
| Analysis passes | 1 | 1 + cross-chunk synthesis | 2, including contradiction/unresolved review |
| Secondary verification | No | Weak/partially supported findings | Critical/high/partial/contradictory findings |
| Retrieval concurrency | 2 | 3 | 3 |
| Chunk concurrency | 1 | 1 | 1 |
| Model-call ceiling | 18 | 40 | 62 |
| Input-token ceiling | 150,000 | 350,000 | 650,000 |
| Output-token ceiling | 50,000 | 110,000 | 190,000 |
| Wall-clock deadline | 8 minutes | 20 minutes | 35 minutes |
| Usage units | 1 | 2 | 5 |

The token ceilings are conservative pre-call reservations based on prompt size and requested output. Persisted token telemetry records provider-reported grader, analysis, merge, enhanced-review, and advisory-verifier usage. Provider-internal retries remain governed by the shared gateway.

## Evidence and failure semantics

- Every retrieval query retains the selected framework, jurisdiction/scope, tenant, and optional benchmark filters.
- There is no unscoped generic-evidence fallback. Standard and Deep can refine the query only inside the same filter.
- No accepted evidence produces a coverage limitation/source-insufficiency outcome, never an invented obligation.
- Chunk failures and configured traversal skips flow into document coverage.
- A Deep enhanced-review or secondary advisory-verifier failure is disclosed in `executionLimitations`; baseline verified results may complete.
- Baseline analysis, mandatory evidence resolution, scoring, cancellation, source sufficiency, or final persistence failure fails the analysis.
- Every expensive loop boundary uses the Batch 4.1 cancellation/deadline check. Final persistence remains conditional on a non-cancelled, non-deleted analysis.
- `COMPLETE` framework coverage remains impossible while `hasKnownRequirementInventory` is false.

## Deployment gates carried from Batch 4.1

- Production historical-payload inventory and cleanup.
- Production ClamAV provisioning.
- Live clean/EICAR/unavailable-scanner smoke testing.
- Frontend production build, until a build exits successfully.

Batch 5 code does not run cleanup, provision services, or alter `.env`.
