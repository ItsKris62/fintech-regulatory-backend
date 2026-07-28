# Phase F Workflow Contracts

## 1. W-CONTENT-04 (Triage)
- **Purpose**: Triages a suggested blog post based on regulatory signals or external items.
- **Trigger**: Manual Webhook.
- **Payload**: JSON containing `sourceItemId`, `suggestionId`, or `regulatorySignalId`.
- **Action**: Generates a triage assessment. Updates the suggestion/signal.
- **Outcome**: The workflow completes explicitly. It does NOT automatically trigger W-CONTENT-05.

## 2. W-CONTENT-05 (Research Pack)
- **Purpose**: Conducts deep-dive research for a triaged suggestion.
- **Trigger**: Manual Webhook.
- **Payload**: JSON containing `suggestionId` or `blogPostId`.
- **Action**: Performs parallel research, extracts facts, checks against corpus.
- **Outcome**: Transitions the pack to `AWAITING_RESEARCH_REVIEW` and halts. Does not automatically trigger drafting or W-CONTENT-06.

## 3. W-CONTENT-06 (Semantic Verification)
- **Purpose**: Verifies an AI-generated draft against the established research pack and source items.
- **Trigger**: Manual Webhook.
- **Payload**: JSON containing `blogPostId`.
- **Action**: Performs claim extraction and verification.
- **Outcome**: Halts with verification result. Never triggers publication.

## 4. W-CONTENT-07 (Freshness Monitor)
- **Purpose**: Scans published content for outdated facts based on new regulatory signals.
- **Trigger**: Scheduled Cron (or manual n8n run for backfills).
- **Action**: Calls `agents.automation.listFreshnessReviewCandidates` to self-discover candidate posts. 
- **Outcome**: Evaluates freshness, flags outdated articles, and potentially generates revision requests.

## 5. W-SHARED-ERR (Error Handler)
- **Purpose**: Unified error handling across all W-CONTENT and other automation workflows.
- **Versioning**: Saved as `n8n_W-SHARED-ERR_error_handler.phase-f-reviewed.json`.
- **Routing Rules**: Standard errors route here. However, expected business stops (like `HUMAN_REVIEW_REQUIRED`, `REJECT`, `MONITOR`, `BLOCKED`, or zero candidates found) DO NOT route to W-SHARED-ERR. They complete successfully.

## Security Constraints
- All TRPC requests authenticate with the `SheriaBot Automation Bearer` credential via `X-Agent-Credential`.
- Workflows are strictly isolated and do not execute raw `Execute Command` / `SSH` nodes, nor arbitrary LLM providers outside of the prescribed integrations.
