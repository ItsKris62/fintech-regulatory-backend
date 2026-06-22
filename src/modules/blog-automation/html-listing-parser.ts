import * as cheerio from 'cheerio';
import { DiscoveredItem } from './rss-parser';

export async function parseHtmlListing(
  pageUrl: string,
  maxItems: number,
  timeoutMs: number
): Promise<DiscoveredItem[]> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(pageUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'SheriaBot-Regulatory-Monitor/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    
    const items: DiscoveredItem[] = [];
    const seenUrls = new Set<string>();
    
    const baseUrl = new URL(pageUrl);

    $('a').each((_, element) => {
      if (items.length >= maxItems) return false;

      const href = $(element).attr('href');
      let title = $(element).text().trim();
      
      // Sometimes title is in an attribute if text is empty
      if (!title) {
        title = $(element).attr('title') || '';
      }

      if (!href || !title || title.length < 5) return true;

      try {
        const resolvedUrl = new URL(href, baseUrl.href);
        
        // We prefer same-domain links or at least safe links
        if (resolvedUrl.hostname !== baseUrl.hostname) return true;
        
        // Skip common non-content links
        if (resolvedUrl.pathname === '/' || resolvedUrl.hash) return true;
        
        const finalUrl = resolvedUrl.toString();
        if (!seenUrls.has(finalUrl)) {
          seenUrls.add(finalUrl);
          items.push({
            title,
            url: finalUrl,
            // Date parsing from HTML is notoriously hard without specific selectors.
            // Leaving undefined for now.
          });
        }
      } catch (e) {
        // Ignore invalid URLs
      }
      return true;
    });

    return items;
  } finally {
    clearTimeout(id);
  }
}
