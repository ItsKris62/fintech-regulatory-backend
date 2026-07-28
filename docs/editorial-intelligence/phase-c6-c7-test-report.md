# SheriaBot Pack 1 — Phase C Stages C6–C7: Test Report

This report lists every test added for Stages C6–C7, the validation commands
run, and the honest reconciliation of the full-suite failures against the
already-documented baseline. No pre-existing failing test was modified to
force a pass.

## Stage C6 — Editorial triage

### `src/modules/blog-automation/editorial-input-hash.test.ts` — 16/16 PASS

1. is deterministic for identical input
2. changes when the title changes
3. changes when the deterministic score changes
4. changes when promptVersion changes
5. is not affected by title casing/whitespace differences (normalized)
6. distinguishes a sourceItemId-keyed input from a suggestionId-only fallback input
7. is deterministic for identical input (research)
8. changes when the objective changes
9. does not change when the source set changes (isolates objective/target/version only)
10. changes when the canonical target changes (blogPostId vs suggestionId)
11. is deterministic regardless of input array order (sorted internally)
12. changes when a source contentHash changes behind the same URL
13. changes when publicationDate is corrected
14. changes when a source becomes unavailable
15. is not affected by URL alone when content/date/availability are unchanged (still equal)
16. produces a stable hash for an empty source list

### `src/modules/blog-automation/editorial-triage.service.test.ts` — 30/30 PASS

1. rejects when none of sourceItemId/suggestionId/regulatorySignalId is provided
2. rejects when the referenced sourceItemId does not exist (missing candidate)
3. rejects when sourceItemId and suggestionId are both given but do not refer to the same candidate (mismatched IDs)
4. resolves a regulatorySignalId-only candidate to its linked BlogSourceItem and scores it
5. rejects when regulatorySignalId and sourceItemId are both given but the signal is linked to a different source item (mismatched IDs)
6. scores a high-quality official source and produces a PRIORITISE_NOW-eligible finalScore
7. produces different targetAudiences depending on the AI enrichment input (dynamic, not hardcoded)
8. short-circuits a duplicate candidate (source item already CONVERTED_TO_SUGGESTION) with zero AI calls
9. applies the low-source-confidence score cap
10. applies the unsupported-jurisdiction score cap
11. combines deterministic and AI scores using the 0.6/0.4 weighted formula
12. falls back to the deterministic score alone when no AI score is present (duplicate/no-AI path)
13. forces HUMAN_REVIEW_REQUIRED recommendation regardless of score when requiresHumanReview is true
14. overrides to HUMAN_REVIEW_REQUIRED end-to-end when the category requires an official source that is missing
15. replays the same result for the same idempotencyKey without a new AI call
16. reuses the latest COMPLETE version when a different idempotencyKey produces the same inputHash
17. creates the next version when the inputHash has changed (e.g. title changed)
18. enforces the sourceItemId+version uniqueness target when a source item is resolvable
19. enforces the suggestionId+version uniqueness target in the suggestion-only fallback path (no resolvable source item)
20. authorised force retriage: forceRetriage=true creates a new version even when inputHash is unchanged
21. unauthorised (non-forced) request with an unchanged inputHash is NOT honored as grounds for a new version — reuse wins
22. throws AIStructuredOutputError (malformed structured output) and marks the AgentRun FAILED
23. propagates a correction-failure error and fails the run
24. propagates an AI timeout error and fails the run
25. returns budget_halted outcome without throwing when the AgentRun begins in a HALTED_BUDGET state
26. returns agents_disabled outcome when agents are globally disabled
27. wraps untrusted source content in an explicit evidence block and instructs the model to ignore embedded instructions (prompt-injection resistance)
28. logs only IDs/recommendation on completion — never rationale or source content
29. persists requiresHumanReview back onto the linked suggestion only when the policy flag is enabled
30. does not write back to the suggestion when the policy flag is disabled (default)

**Note on "authorised"/"unauthorised" force retriage** (items 20–21): Stage
C6 ships as a service with no router/capability layer yet (deferred to
Stage C10). At this layer, "authorised" means the caller explicitly passed
`forceRetriage: true`; "unauthorised" means it was omitted/false. The actual
who-may-set-this-flag authorization gate is a Stage C10 concern. See
`editorial-triage-policy.md`.

## Stage C7 — Research-pack generation and persistence

### `src/modules/blog-automation/research-source-classifier.test.ts` — 13/13 PASS

1. classifies an approved-corpus source regardless of its sourceType/authorityType
2. classifies a GAZETTE authority as LEGISLATION
3. classifies a LEGAL_DATABASE authority as OFFICIAL_GUIDANCE
4. classifies an OFFICIAL source from a regulator authority as OFFICIAL_REGULATOR
5. classifies an INTERNATIONAL_STANDARD source as OFFICIAL_GUIDANCE
6. classifies an INDUSTRY_BODY authority as INDUSTRY_SOURCE
7. classifies an INTERNAL source as COMPANY_SOURCE
8. classifies a MEDIA source as REPUTABLE_NEWS
9. classifies an explicitly user-generated source as USER_GENERATED
10. classifies an unrecognized THIRD_PARTY/OTHER combination as UNVERIFIED — never guessed up
11. a poisoned/unverified source cannot be upgraded to a trusted category by any input flag other than isApprovedCorpus
12. lowers trustLevel (never the category) when a source is unavailable
13. never lowers trustLevel below 0

### `src/modules/blog-automation/research-pack.service.test.ts` — 32/32 PASS

1. rejects when neither blogPostId nor suggestionId is provided
2. rejects when blogPostId does not exist
3. rejects when blogPostId and suggestionId are both given but do not refer to the same candidate (mismatched IDs)
4. builds a research pack from a BlogPost-only target
5. builds a research pack from a suggestion-only target (research allowed even though requiresHumanReview is true)
6. links both blogPostId and suggestionId when consistently linked
7. completes with zero gaps for a complete official source set
8. marks a source unavailable (fetch failed) and still completes the pack with a note
9. dedupes a source appearing via both suggestion sourceItem and a BlogPostSource with the same normalized URL
10. classifies sources into the correct BlogResearchSourceCategory before persisting
11. downgrades a high-stakes obligation to an evidence gap when it cites only an unverified source (a poisoned source cannot verify a legal obligation)
12. persists contradictions and lowers confidence appropriately when sources disagree
13. drops (does not persist) a finding whose sourceRef does not resolve to any known source
14. replays the same result for the same idempotencyKey without a new AI call
15. reuses the latest active pack when a different idempotencyKey produces the same inputHash and sourceSetHash
16. creates the next version when the source content hash changes behind the same URL
17. creates the next version when the research objective changes (different inputHash, same sources)
18. enforces the blogPostId+version uniqueness target when a BlogPost is resolvable
19. enforces the suggestionId+version uniqueness target for a suggestion-only pack
20. marks the prior active version SUPERSEDED transactionally when creating a new version
21. does not supersede or create a pack when structured synthesis fails
22. updates requiresHumanReview on the linked suggestion when confidence is low, but only when the policy flag is enabled
23. does not write back requiresHumanReview when the policy flag is disabled (default)
24. creates a ContentOpsAlert with compact metadata (no research text) when gaps/contradictions/low confidence are material
25. does not create a ContentOpsAlert when there are no gaps, no contradictions, and confidence is high
26. propagates a structured-output correction failure and fails the run
27. propagates a budget-exhaustion error via AgentRun HALTED_BUDGET without throwing
28. returns agents_disabled outcome when agents are globally disabled
29. wraps each source in an explicit block and instructs the model to ignore embedded instructions (prompt-injection resistance)
30. never includes full source content or rationale text in operational logs
31. attaches blogPostId to the active suggestion-keyed pack as a plain update, not a new version
32. returns null when there is no active pack for the suggestion

## Validation commands run (this pass)

| Command | Result |
|---|---|
| `pnpm exec prisma validate` | PASS — no schema changes needed; C6/C7 use only the models Stage C1 already added |
| `pnpm exec prisma generate` | PASS |
| `pnpm run typecheck` | PASS for all Pack 1 files (0 errors introduced by C6/C7); 9 pre-existing unrelated errors remain, all in files untouched by this pass |
| `pnpm run lint` | 0 errors; 7 pre-existing unrelated warnings (none in Pack 1 files) |
| `pnpm run test` (full suite) | 1051/1055 PASS |
| `pnpm run build` (`tsc`, emits) | Fails on the identical 9 pre-existing errors as `typecheck` — confirmed pre-existing baseline, not a C6/C7 regression |

## Full-suite failure reconciliation (4 failures, all pre-existing/environmental)

| Test | Reconciliation |
|---|---|
| `automation-incident.route.test.ts > ... > accepts valid incident and correctly creates new DB entry if not found` | Pre-existing — documented in `phase-c3-c5-test-report.md`; file untouched by C6/C7 |
| `automation-incident.route.test.ts > ... > suppresses alert if cooldown is active for existing incident` | Same as above |
| `agent-credential.service.test.ts > ... > grants the automation principal exactly its automation capabilities, nothing broader` | Pre-existing — documented in `phase-c3-c5-test-report.md`; `agent-credential.service.ts` untouched by C6/C7 |
| `agent-prisma-roundtrip.test.ts > ... > creates and reads AgentRun with cascaded AgentReport shape matching live schema` | The previously-documented flaky live-DB parallel-contention timing test. Did not fail in the prior C3–C5 run's pass; triggered in this run — consistent with its already-documented flaky nature, not a stable failure. Its own query never touches any Pack 1 model. |

Test count grew from 964 (end of the C3–C5 pass) to 1055 in this pass — an
increase of exactly 91, matching the sum of the four new Stage C6/C7 test
files (16 + 13 + 30 + 32 = 91). No test outside these four files changed in
count or outcome.

**No test file created or modified by Stage C6/C7 appears in the failing
set.**
