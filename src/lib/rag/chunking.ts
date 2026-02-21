import { logger } from '@/utils/logger';

/**
 * Chunk configuration
 */
export interface ChunkConfig {
  maxChunkSize: number;      // Maximum characters per chunk
  chunkOverlap: number;       // Overlap between chunks
  respectSentences: boolean;  // Try to break at sentence boundaries
  respectSections: boolean;   // Try to keep sections together
}

/**
 * Document chunk
 */
export interface DocumentChunk {
  index: number;
  text: string;
  startChar: number;
  endChar: number;
  section?: string;
  subsection?: string;
  citation?: string;
  metadata?: Record<string, any>;
}

/**
 * Default chunk configuration for legal documents
 */
const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  maxChunkSize: 1000,        // ~250 tokens
  chunkOverlap: 200,         // ~50 tokens overlap
  respectSentences: true,
  respectSections: true,
};

/**
 * Legal document section patterns
 * Matches patterns like "Section 1", "Article III", "Clause 4.2.1"
 */
const SECTION_PATTERNS = [
  /^(SECTION|Section|SEC\.|Sec\.)\s+(\d+[A-Za-z]?)/,
  /^(ARTICLE|Article|ART\.|Art\.)\s+([IVXLCDM]+|\d+)/,
  /^(CHAPTER|Chapter|CHAP\.|Chap\.)\s+(\d+|[IVXLCDM]+)/,
  /^(PART|Part)\s+([IVXLCDM]+|\d+[A-Za-z]?)/,
  /^(CLAUSE|Clause)\s+([\d.]+)/,
  /^(\d+[A-Za-z]?)\.\s+/,  // Numbered sections like "1.", "2A."
  /^\(([a-z]|\d+)\)\s+/,    // Subsections like "(a)", "(1)"
];

/**
 * Citation patterns in text
 */
const CITATION_PATTERNS = [
  /([A-Z][A-Za-z\s]+Act\s+\d{4})/g,
  /([A-Z][A-Za-z\s]+Regulations?\s+\d{4})/g,
  /(Section\s+\d+[A-Za-z]?(?:\(\d+\))?)/g,
  /(Article\s+[IVXLCDM]+)/g,
];

/**
 * Detect section headers in text
 */
function detectSectionHeader(line: string): {
  isHeader: boolean;
  section?: string;
} {
  const trimmed = line.trim();

  for (const pattern of SECTION_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      return {
        isHeader: true,
        section: match[0],
      };
    }
  }

  // Also check for all-caps headers (common in legal docs)
  if (trimmed === trimmed.toUpperCase() && trimmed.length > 3 && trimmed.length < 100) {
    return {
      isHeader: true,
      section: trimmed,
    };
  }

  return { isHeader: false };
}

/**
 * Extract citations from text
 */
function extractCitations(text: string): string[] {
  const citations: Set<string> = new Set();

  for (const pattern of CITATION_PATTERNS) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      citations.add(match[1]);
    }
  }

  return Array.from(citations);
}

/**
 * Split text into sentences
 * Handles legal text quirks (e.g., abbreviations, section numbers)
 */
function splitIntoSentences(text: string): string[] {
  // Replace common abbreviations to prevent false splits
  let processed = text
    .replace(/Mr\./g, 'Mr<DOT>')
    .replace(/Mrs\./g, 'Mrs<DOT>')
    .replace(/Dr\./g, 'Dr<DOT>')
    .replace(/Prof\./g, 'Prof<DOT>')
    .replace(/Inc\./g, 'Inc<DOT>')
    .replace(/Ltd\./g, 'Ltd<DOT>')
    .replace(/Co\./g, 'Co<DOT>')
    .replace(/Sec\./g, 'Sec<DOT>')
    .replace(/Art\./g, 'Art<DOT>')
    .replace(/No\./g, 'No<DOT>')
    .replace(/vs\./g, 'vs<DOT>');

  // Split on sentence boundaries
  const sentences = processed
    .split(/([.!?]+\s+)/)
    .filter(s => s.trim().length > 0);

  // Restore abbreviations
  return sentences.map(s => s.replace(/<DOT>/g, '.'));
}

/**
 * Split text at section boundaries
 */
function splitBySections(text: string): Array<{
  section: string;
  content: string;
}> {
  const lines = text.split('\n');
  const sections: Array<{ section: string; content: string }> = [];
  
  let currentSection = 'Preamble';
  let currentContent: string[] = [];

  for (const line of lines) {
    const { isHeader, section } = detectSectionHeader(line);

    if (isHeader && section) {
      // Save previous section
      if (currentContent.length > 0) {
        sections.push({
          section: currentSection,
          content: currentContent.join('\n').trim(),
        });
      }

      // Start new section
      currentSection = section;
      currentContent = [line];
    } else {
      currentContent.push(line);
    }
  }

  // Save last section
  if (currentContent.length > 0) {
    sections.push({
      section: currentSection,
      content: currentContent.join('\n').trim(),
    });
  }

  return sections;
}

/**
 * Chunk text using sliding window with sentence awareness
 */
function chunkWithSlidingWindow(
  text: string,
  maxSize: number,
  overlap: number,
  respectSentences: boolean
): string[] {
  if (text.length <= maxSize) {
    return [text];
  }

  const chunks: string[] = [];
  
  if (respectSentences) {
    const sentences = splitIntoSentences(text);
    let currentChunk = '';
    let i = 0;

    while (i < sentences.length) {
      const sentence = sentences[i];

      // If adding this sentence exceeds max size, save current chunk
      if (currentChunk.length + sentence.length > maxSize && currentChunk.length > 0) {
        chunks.push(currentChunk.trim());

        // Calculate overlap: how many sentences to include from previous chunk
        let overlapSize = 0;
        let overlapSentences: string[] = [];
        
        for (let j = i - 1; j >= 0 && overlapSize < overlap; j--) {
          const prevSentence = sentences[j];
          if (overlapSize + prevSentence.length <= overlap) {
            overlapSentences.unshift(prevSentence);
            overlapSize += prevSentence.length;
          } else {
            break;
          }
        }

        currentChunk = overlapSentences.join(' ');
      }

      currentChunk += (currentChunk ? ' ' : '') + sentence;
      i++;
    }

    // Add last chunk
    if (currentChunk.trim().length > 0) {
      chunks.push(currentChunk.trim());
    }
  } else {
    // Simple character-based chunking
    let start = 0;
    
    while (start < text.length) {
      const end = Math.min(start + maxSize, text.length);
      chunks.push(text.slice(start, end));
      start = end - overlap;
    }
  }

  return chunks;
}

/**
 * Chunk document into optimal pieces for embedding
 * @param text Document text
 * @param config Chunk configuration
 * @param metadata Additional metadata to attach
 */
export function chunkDocument(
  text: string,
  config: Partial<ChunkConfig> = {},
  metadata: Record<string, any> = {}
): DocumentChunk[] {
  const finalConfig = { ...DEFAULT_CHUNK_CONFIG, ...config };

  logger.info({
    type: 'document_chunking_started',
    textLength: text.length,
    config: finalConfig,
  });

  const chunks: DocumentChunk[] = [];
  let globalCharIndex = 0;

  // Split by sections if requested
  if (finalConfig.respectSections) {
    const sections = splitBySections(text);

    for (const { section, content } of sections) {
      const sectionChunks = chunkWithSlidingWindow(
        content,
        finalConfig.maxChunkSize,
        finalConfig.chunkOverlap,
        finalConfig.respectSentences
      );

      for (const chunkText of sectionChunks) {
        const citations = extractCitations(chunkText);

        chunks.push({
          index: chunks.length,
          text: chunkText,
          startChar: globalCharIndex,
          endChar: globalCharIndex + chunkText.length,
          section,
          citation: citations.length > 0 ? citations.join('; ') : undefined,
          metadata,
        });

        globalCharIndex += chunkText.length;
      }
    }
  } else {
    // Simple chunking without section awareness
    const simpleChunks = chunkWithSlidingWindow(
      text,
      finalConfig.maxChunkSize,
      finalConfig.chunkOverlap,
      finalConfig.respectSentences
    );

    for (const chunkText of simpleChunks) {
      const citations = extractCitations(chunkText);

      chunks.push({
        index: chunks.length,
        text: chunkText,
        startChar: globalCharIndex,
        endChar: globalCharIndex + chunkText.length,
        citation: citations.length > 0 ? citations.join('; ') : undefined,
        metadata,
      });

      globalCharIndex += chunkText.length;
    }
  }

  logger.info({
    type: 'document_chunking_complete',
    chunkCount: chunks.length,
    avgChunkSize: Math.round(text.length / chunks.length),
  });

  return chunks;
}

/**
 * Chunk legal act/regulation with special handling
 */
export function chunkLegalAct(
  actText: string,
  actName: string,
  year: number,
  regulatoryArea: string
): DocumentChunk[] {
  logger.info({
    type: 'legal_act_chunking',
    actName,
    year,
  });

  const chunks = chunkDocument(
    actText,
    {
      maxChunkSize: 800,        // Slightly smaller for legal precision
      chunkOverlap: 150,
      respectSentences: true,
      respectSections: true,
    },
    {
      actName,
      year,
      regulatoryArea,
      documentType: 'LEGAL_ACT',
    }
  );

  // Add act name to section for better context
  return chunks.map(chunk => ({
    ...chunk,
    section: `${actName} - ${chunk.section}`,
  }));
}

/**
 * Calculate optimal chunk size based on content type
 */
export function getOptimalChunkSize(contentType: string): number {
  const sizes: Record<string, number> = {
    'legal_act': 800,
    'regulation': 900,
    'guideline': 1000,
    'case_law': 1200,
    'policy': 1000,
    'article': 1200,
  };

  return sizes[contentType.toLowerCase()] || 1000;
}

/**
 * Merge small chunks that are below minimum size
 */
export function mergeSmallChunks(
  chunks: DocumentChunk[],
  minSize: number = 300
): DocumentChunk[] {
  if (chunks.length === 0) {
    return chunks;
  }

  const merged: DocumentChunk[] = [];
  let currentMerge: DocumentChunk | null = null;

  for (const chunk of chunks) {
    if (chunk.text.length < minSize && currentMerge) {
      // Merge with previous chunk
      currentMerge.text += '\n\n' + chunk.text;
      currentMerge.endChar = chunk.endChar;
      
      // Combine citations
      if (chunk.citation) {
        currentMerge.citation = currentMerge.citation
          ? `${currentMerge.citation}; ${chunk.citation}`
          : chunk.citation;
      }
    } else if (chunk.text.length < minSize) {
      // Start a new merge
      currentMerge = { ...chunk };
    } else {
      // Chunk is large enough, save any pending merge
      if (currentMerge) {
        merged.push(currentMerge);
        currentMerge = null;
      }
      merged.push(chunk);
    }
  }

  // Save final merge
  if (currentMerge) {
    merged.push(currentMerge);
  }

  logger.debug({
    type: 'chunks_merged',
    original: chunks.length,
    merged: merged.length,
  });

  return merged;
}

/**
 * Preview chunks (useful for testing)
 */
export function previewChunks(chunks: DocumentChunk[], maxChunks: number = 3): void {
  console.log(`\n📄 Document Chunks Preview (showing ${Math.min(maxChunks, chunks.length)} of ${chunks.length})\n`);

  for (let i = 0; i < Math.min(maxChunks, chunks.length); i++) {
    const chunk = chunks[i];
    console.log(`Chunk ${i + 1}:`);
    console.log(`  Section: ${chunk.section || 'N/A'}`);
    console.log(`  Length: ${chunk.text.length} chars`);
    console.log(`  Citations: ${chunk.citation || 'None'}`);
    console.log(`  Text preview: ${chunk.text.substring(0, 200)}...`);
    console.log();
  }
}