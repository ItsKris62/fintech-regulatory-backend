import { chunkDocument } from '@/lib/rag/chunking';
import {
  PageSpan,
  ProvisionAnchor,
  SourceVersionRef,
  V2ChunkMetadata,
  prepareV2ChunkMetadata,
} from './source-metadata';

export type PageAwareTextPage = {
  pageNumber?: number | null;
  text: string;
  startChar: number;
  endChar: number;
};

export type PageAwareText = {
  text: string;
  pages: PageAwareTextPage[];
  pageMetadataReliable: boolean;
  sourceType: 'pdf' | 'docx' | 'txt' | 'unknown';
};

export type V2LegalChunk = {
  index: number;
  text: string;
  section?: string | null;
  metadata: V2ChunkMetadata & {
    parser: 'v2-legal-structure';
    pageMetadataReliable: boolean;
    fallbackReason?: string | null;
  };
};

const HEADER_PATTERNS: Array<{
  kind: 'sectionNumber' | 'clauseNumber' | 'scheduleNumber' | 'heading';
  pattern: RegExp;
}> = [
  { kind: 'scheduleNumber', pattern: /^(SCHEDULE|Schedule)\s+([A-Z0-9IVXLCDM.-]+)/ },
  { kind: 'sectionNumber', pattern: /^(SECTION|Section|SEC\.|Sec\.)\s+(\d+[A-Za-z]?)/ },
  { kind: 'sectionNumber', pattern: /^(REGULATION|Regulation|RULE|Rule)\s+([\d.]+[A-Za-z]?)/ },
  { kind: 'clauseNumber', pattern: /^(CLAUSE|Clause)\s+([\d.]+[A-Za-z]?)/ },
  { kind: 'sectionNumber', pattern: /^(\d+[A-Za-z]?)\.\s+(.+)/ },
  { kind: 'heading', pattern: /^(PART|Part|CHAPTER|Chapter)\s+([A-Z0-9IVXLCDM.-]+)/ },
];

function normalizeWhitespace(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

export function buildPageAwareText(
  text: string,
  input: { sourceType?: PageAwareText['sourceType']; pageBreaksReliable?: boolean } = {},
): PageAwareText {
  const normalized = normalizeWhitespace(text);
  const sourceType = input.sourceType ?? 'unknown';
  const pageMetadataReliable = input.pageBreaksReliable === true && normalized.includes('\f');
  const rawPages = pageMetadataReliable ? normalized.split(/\f+/) : [normalized];

  let cursor = 0;
  const pages = rawPages.map((pageText, index) => {
    const trimmed = pageText.trim();
    const startChar = normalized.indexOf(pageText, cursor);
    const safeStart = startChar >= 0 ? startChar : cursor;
    const endChar = safeStart + pageText.length;
    cursor = endChar;
    return {
      pageNumber: pageMetadataReliable ? index + 1 : null,
      text: trimmed,
      startChar: safeStart,
      endChar,
    };
  }).filter((page) => page.text.length > 0);

  return {
    text: normalized.replace(/\f+/g, '\n\n'),
    pages: pages.length > 0 ? pages : [{ pageNumber: null, text: normalized, startChar: 0, endChar: normalized.length }],
    pageMetadataReliable,
    sourceType,
  };
}

function detectHeader(line: string): ProvisionAnchor & { label?: string | null } {
  const trimmed = line.trim();
  for (const { kind, pattern } of HEADER_PATTERNS) {
    const match = trimmed.match(pattern);
    if (!match) continue;

    const label = match[0].trim();
    if (kind === 'sectionNumber') return { sectionNumber: match[2] ?? match[1], label };
    if (kind === 'clauseNumber') return { clauseNumber: match[2], label };
    if (kind === 'scheduleNumber') return { scheduleNumber: match[2], label };
    return { headingPath: [label], label };
  }

  if (trimmed.length >= 4 && trimmed.length <= 100 && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)) {
    return { headingPath: [trimmed], label: trimmed };
  }

  return {};
}

function pageSpanForRange(pages: PageAwareTextPage[], startChar: number, endChar: number, reliable: boolean): PageSpan {
  if (!reliable) return { pageStart: null, pageEnd: null };
  const touched = pages.filter((page) => page.endChar >= startChar && page.startChar <= endChar && page.pageNumber);
  if (touched.length === 0) return { pageStart: null, pageEnd: null };
  return {
    pageStart: touched[0].pageNumber ?? null,
    pageEnd: touched[touched.length - 1].pageNumber ?? touched[0].pageNumber ?? null,
  };
}

function splitLargeBlock(text: string, maxChunkSize: number): string[] {
  if (text.length <= maxChunkSize) return [text];
  return chunkDocument(text, {
    maxChunkSize,
    chunkOverlap: 0,
    respectSentences: true,
    respectSections: false,
  }).map((chunk) => chunk.text);
}

export function chunkPageAwareLegalText(input: {
  documentId: string;
  pageAwareText: PageAwareText;
  documentChecksum?: string | null;
  sourceVersion?: SourceVersionRef | null;
  authorityStatus?: string | null;
  corpusStatus?: string | null;
  isBinding?: boolean | null;
  maxChunkSize?: number;
}): V2LegalChunk[] {
  const maxChunkSize = input.maxChunkSize ?? 1800;
  const lines = input.pageAwareText.text.split('\n');
  const blocks: Array<{
    text: string;
    startChar: number;
    endChar: number;
    anchor: ProvisionAnchor;
    label?: string | null;
    fallbackReason?: string | null;
  }> = [];

  let currentLines: string[] = [];
  let currentStart = 0;
  let cursor = 0;
  let currentAnchor: ProvisionAnchor = {};
  let currentLabel: string | null = null;
  let headingPath: string[] = [];

  const flush = (endChar: number, fallbackReason?: string | null) => {
    const text = currentLines.join('\n').trim();
    if (!text) return;
    blocks.push({
      text,
      startChar: currentStart,
      endChar,
      anchor: { ...currentAnchor, headingPath: currentAnchor.headingPath ?? headingPath },
      label: currentLabel,
      fallbackReason: fallbackReason ?? null,
    });
  };

  for (const line of lines) {
    const lineStart = cursor;
    const lineEnd = cursor + line.length;
    cursor = lineEnd + 1;
    const header = detectHeader(line);

    if (header.label && currentLines.length > 0) {
      flush(lineStart);
      currentLines = [];
      currentStart = lineStart;
    }

    if (header.headingPath?.length) {
      headingPath = header.headingPath;
    }
    if (header.label) {
      currentAnchor = {
        sectionNumber: header.sectionNumber ?? null,
        clauseNumber: header.clauseNumber ?? null,
        scheduleNumber: header.scheduleNumber ?? null,
        headingPath,
      };
      currentLabel = header.label;
    }
    if (currentLines.length === 0) currentStart = lineStart;
    currentLines.push(line);
  }
  flush(input.pageAwareText.text.length, blocks.length === 0 ? 'no_detectable_legal_structure' : null);

  const sourceBlocks = blocks.length > 0
    ? blocks
    : [{
        text: input.pageAwareText.text,
        startChar: 0,
        endChar: input.pageAwareText.text.length,
        anchor: {},
        label: null,
        fallbackReason: 'no_detectable_legal_structure',
      }];

  const chunks: V2LegalChunk[] = [];
  for (const block of sourceBlocks) {
    for (const part of splitLargeBlock(block.text, maxChunkSize)) {
      const index = chunks.length;
      const partStart = input.pageAwareText.text.indexOf(part, block.startChar);
      const safeStart = partStart >= 0 ? partStart : block.startChar;
      const safeEnd = safeStart + part.length;
      const pageSpan = pageSpanForRange(
        input.pageAwareText.pages,
        safeStart,
        safeEnd,
        input.pageAwareText.pageMetadataReliable,
      );
      const metadata = prepareV2ChunkMetadata({
        documentId: input.documentId,
        chunkIndex: index,
        content: part,
        documentChecksum: input.documentChecksum ?? null,
        pageSpan,
        provisionAnchor: block.anchor,
        sourceVersion: input.sourceVersion ?? null,
        charStart: safeStart,
        charEnd: safeEnd,
        authorityStatus: input.authorityStatus ?? null,
        corpusStatus: input.corpusStatus ?? null,
        isBinding: input.isBinding ?? null,
        indexVersion: 'v2',
      });

      chunks.push({
        index,
        text: part,
        section: block.label ?? block.anchor.sectionNumber ?? block.anchor.clauseNumber ?? block.anchor.scheduleNumber ?? null,
        metadata: {
          ...metadata,
          parser: 'v2-legal-structure',
          pageMetadataReliable: input.pageAwareText.pageMetadataReliable,
          fallbackReason: block.fallbackReason ?? null,
        },
      });
    }
  }

  return chunks;
}
