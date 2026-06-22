# Blog Automation Source Discovery & Scoring

This module handles the discovery of regulatory updates and scores them to surface high-quality blog suggestions.

## Relevance Scoring Logic

The relevance scoring engine (`relevance-scoring.service.ts`) computes a `relevanceScore` (0-100) and categorizes source items based on:

1. **Source Authority Score**: Higher scores for `OFFICIAL` (e.g. Central Bank) and `INTERNATIONAL_STANDARD`.
2. **Authority Type Score**: High impact authorities (e.g. `CENTRAL_BANK`, `DATA_PROTECTION`, `AML_CFT`) receive the highest weight.
3. **Keyword Score**: Scans titles and summaries for high-priority keywords (`regulation`, `penalty`, `fintech`, `guideline`, etc.).
4. **Recency Score**: Favors items discovered or published within the last 30, 90, or 180 days.
5. **Jurisdiction Score**: Prioritizes primary jurisdictions (KE, MW, RW, NG).
6. **Enforcement / Update Signals**: Identifies enforcement actions, compliance guides, and regulatory updates to assign the correct `category` and `articleType`.

### Thresholds
- **Below 45**: Status set to `SCORED` (not converted).
- **45 to 100**: Converted into a `BlogArticleSuggestion` with priority `MEDIUM`, `HIGH`, or `URGENT`.

## Suggestion Queue

Admin users can review suggestions at `/admin/content/blog/suggestions`. 
From the queue, admins can:
- **Approve for Draft**: Prepares the suggestion for AI draft generation (Sprint 3.5).
- **Request More Sources**: Flags the suggestion as needing more context.
- **Dismiss**: Removes the suggestion from the queue.
