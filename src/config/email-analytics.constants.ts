/**
 * UTM and Resend tag constants for marketing emails.
 *
 * UTMs are appended to outbound URLs ONLY when the FeatureFlag
 * 'marketing_utm_tracking' is enabled. This prevents URL noise when
 * no analytics tool is configured to receive the tracking parameters.
 */

export const UTM_DEFAULTS = {
  source: 'sheriabot',
  medium: 'email',
} as const;

/**
 * Build a UTM-tagged URL when tracking is enabled.
 *
 * @param baseUrl    Original URL without UTM parameters
 * @param campaign   Campaign identifier (matches MarketingCampaign.name slug)
 * @param tracking   Whether tracking is enabled (read from FeatureFlag)
 * @returns Original URL or URL with utm_source/utm_medium/utm_campaign appended
 */
export function maybeAppendUtm(
  baseUrl: string,
  campaign: string,
  tracking: boolean,
): string {
  if (!tracking) return baseUrl;

  try {
    const url = new URL(baseUrl);
    url.searchParams.set('utm_source', UTM_DEFAULTS.source);
    url.searchParams.set('utm_medium', UTM_DEFAULTS.medium);
    url.searchParams.set('utm_campaign', campaign);
    return url.toString();
  } catch {
    // Malformed URL — return as-is rather than crash the send
    return baseUrl;
  }
}

export const FEATURE_FLAG_UTM_TRACKING = 'marketing_utm_tracking' as const;
