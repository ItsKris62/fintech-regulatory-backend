import Parser from 'rss-parser';

export interface DiscoveredItem {
  title: string;
  url: string;
  publicationDate?: Date;
  summary?: string;
}

const parser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': 'SheriaBot-Regulatory-Monitor/1.0',
  },
});

export async function parseRssFeed(feedUrl: string, maxItems: number, timeoutMs: number): Promise<DiscoveredItem[]> {
  // Override timeout dynamically if needed, though rss-parser takes it in constructor.
  // We can use AbortController with standard fetch if rss-parser timeout is insufficient,
  // but rss-parser's native timeout is usually fine.
  
  // To strictly enforce the dynamic timeout:
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const feed = await parser.parseURL(feedUrl);
    
    const items: DiscoveredItem[] = [];
    
    for (const item of feed.items) {
      if (items.length >= maxItems) break;
      
      if (!item.title || !item.link) continue;
      
      items.push({
        title: item.title,
        url: item.link,
        publicationDate: item.pubDate ? new Date(item.pubDate) : undefined,
        summary: item.contentSnippet || item.content || item.summary,
      });
    }
    
    return items;
  } finally {
    clearTimeout(id);
  }
}
