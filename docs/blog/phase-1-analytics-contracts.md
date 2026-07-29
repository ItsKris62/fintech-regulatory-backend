# SheriaBot Blog Phase 1 Analytics Contracts

Phase 1 adds the analytics and public-contract foundation for a future dynamic
Blog redesign. It does not redesign the public Blog UI and does not expose a
public Trending section.

## Event Taxonomy

Frontend Blog analytics events are centrally defined in
`frontend/lib/analytics/blog-events.ts`.

Required events:

- `blog_listing_viewed`
- `blog_article_impression`
- `blog_article_opened`
- `blog_article_engagement_started`
- `blog_article_engaged`
- `blog_article_completed`
- `blog_search_performed`
- `blog_search_no_results`
- `blog_category_selected`
- `blog_tag_selected`
- `blog_featured_article_opened`
- `blog_related_article_opened`
- `blog_source_opened`
- `blog_product_cta_clicked`
- `blog_newsletter_cta_viewed`
- `blog_newsletter_subscription_completed`
- `blog_feedback_submitted`
- `blog_topic_request_submitted`
- `blog_article_shared`

## Search Privacy

Raw Blog search text must not be sent to PostHog by default.

The frontend sends:

- normalised query length;
- result count;
- whether results were found;
- selected category/page where applicable;
- a non-reversible SHA-256 fingerprint when browser crypto is available.

The global `$pageview` tracker strips `q`, `query`, and `search` parameters from
Blog URLs before setting `$current_url`.

## Reader Session And Deduplication

The frontend creates an ephemeral Blog reading-session ID in `sessionStorage`.
It is scoped to the browser session and is not used for cross-device matching.

Milestone events use client-side deduplication so React re-renders, Strict Mode
remounts, and back/forward navigation do not inflate:

- article impressions;
- article opened;
- engagement started;
- engaged;
- completed;
- newsletter CTA viewed.

## Impression Contract

An article impression fires only after an article card is at least 50 percent
visible for 750 ms. The event is emitted once per post and placement in the
current listing session.

Placements:

- `featured`
- `recent`
- `search`
- `category`
- `related`

## Article Engagement Contract

`blog_article_opened` fires once when canonical article metadata is available on
the detail page.

Active reading time increments only when:

- the document is visible;
- the window has focus;
- the article body is at least meaningfully visible.

Milestones:

- `blog_article_engagement_started`: 10 active seconds;
- `blog_article_engaged`: 30 active seconds;
- `blog_article_completed`: at least 30 active seconds and at least 75 percent
  article scroll depth.

Estimated reading time remains metadata only. It is not treated as actual
engagement.

## Backend Public Contracts

Canonical Blog feedback uses durable application data:

- `blog.submitFeedback`
- `blog.getPublicFeedbackSummary`

Newsletter subscription reuses marketing Contact and ConsentRecord
infrastructure:

- `publicMarketing.subscribeBlogNewsletter`

Topic requests enter a controlled editorial queue:

- `blog.submitTopicRequest`

## Editorial Metrics Contract

Metrics are described in `src/modules/blog/editorial-metrics.ts`.

Public Blog requests must not call PostHog live. The intended future
architecture is:

```text
PostHog engagement events
        +
Durable feedback and marketing records
        ↓
Scheduled aggregation
        ↓
Blog performance snapshot
        ↓
Admin editorial dashboard and future trending API
```

Public Trending remains disabled until enough trustworthy, time-windowed
engagement data exists and a scheduled aggregation/ranking contract is approved.
