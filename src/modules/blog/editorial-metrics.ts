export interface BlogEditorialMetric {
  postId: string;
  uniqueReaders: number;
  impressions: number;
  opens: number;
  engagedReaders: number;
  completedReaders: number;
  averageActiveReadSeconds: number;
  completionRate: number | null;
  helpfulCount: number;
  notHelpfulCount: number;
  newsletterConversions: number;
  productCtaConversions: number;
  sourceClicks: number;
  periodStart: Date;
  periodEnd: Date;
}

export type BlogEditorialMetricField = keyof BlogEditorialMetric;

export interface BlogEditorialMetricSource {
  field: BlogEditorialMetricField;
  source: 'posthog_event' | 'application_table' | 'scheduled_aggregation';
  eventName?: string;
  tableName?: string;
  notes: string;
}

export const BLOG_EDITORIAL_METRIC_SOURCES: BlogEditorialMetricSource[] = [
  {
    field: 'uniqueReaders',
    source: 'scheduled_aggregation',
    eventName: 'blog_article_opened',
    notes: 'Future aggregate from PostHog distinct anonymous readers by post and time window.',
  },
  {
    field: 'impressions',
    source: 'posthog_event',
    eventName: 'blog_article_impression',
    notes: 'Card visibility event; not equivalent to popularity.',
  },
  {
    field: 'opens',
    source: 'posthog_event',
    eventName: 'blog_article_opened',
    notes: 'Article detail loaded with canonical post metadata.',
  },
  {
    field: 'engagedReaders',
    source: 'posthog_event',
    eventName: 'blog_article_engaged',
    notes: 'Observed active reading threshold met.',
  },
  {
    field: 'completedReaders',
    source: 'posthog_event',
    eventName: 'blog_article_completed',
    notes: 'Observed active time plus scroll-depth completion threshold met.',
  },
  {
    field: 'averageActiveReadSeconds',
    source: 'scheduled_aggregation',
    eventName: 'blog_article_completed',
    notes: 'Computed from milestone event properties, not continuous client beacons.',
  },
  {
    field: 'completionRate',
    source: 'scheduled_aggregation',
    notes: 'completedReaders divided by opens when sample size is sufficient.',
  },
  {
    field: 'helpfulCount',
    source: 'application_table',
    tableName: 'BlogPostFeedback',
    notes: 'Durable canonical feedback count.',
  },
  {
    field: 'notHelpfulCount',
    source: 'application_table',
    tableName: 'BlogPostFeedback',
    notes: 'Durable canonical feedback count.',
  },
  {
    field: 'newsletterConversions',
    source: 'posthog_event',
    eventName: 'blog_newsletter_subscription_completed',
    notes: 'Analytics event only; email address remains in marketing tables, never in PostHog.',
  },
  {
    field: 'productCtaConversions',
    source: 'posthog_event',
    eventName: 'blog_product_cta_clicked',
    notes: 'Stable CTA identifier required.',
  },
  {
    field: 'sourceClicks',
    source: 'posthog_event',
    eventName: 'blog_source_opened',
    notes: 'Safe source-domain click events.',
  },
  {
    field: 'periodStart',
    source: 'scheduled_aggregation',
    notes: 'Aggregation window start.',
  },
  {
    field: 'periodEnd',
    source: 'scheduled_aggregation',
    notes: 'Aggregation window end.',
  },
  {
    field: 'postId',
    source: 'application_table',
    tableName: 'BlogPost',
    notes: 'Canonical public Blog identifier.',
  },
];
