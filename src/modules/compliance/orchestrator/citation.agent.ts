import type { SearchResult } from '@/lib/rag/rag.service';

export interface PackagedCitations {
  inline: string[];
  full: string[];
}

/** Pure transform — no AI call. Deduplicates and formats citations from search results. */
export function packCitations(results: SearchResult[]): PackagedCitations {
  const inline: string[] = [];
  const full: string[] = [];
  const seenKeys = new Set<string>();
  const seenFull = new Set<string>();

  for (const r of results) {
    const key = `${r.documentTitle}|${r.section ?? ''}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      inline.push(r.section ? `${r.documentTitle} § ${r.section}` : r.documentTitle);
    }

    if (r.citation) {
      for (const c of r.citation.split(';').map(s => s.trim()).filter(Boolean)) {
        if (!seenFull.has(c)) {
          seenFull.add(c);
          full.push(c);
        }
      }
    }
  }

  return { inline, full };
}
