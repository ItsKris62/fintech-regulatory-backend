import type { OcrConfig } from './config';

export type ExtractionMethod = 'NATIVE' | 'OCR';
export type OcrQualityStatus = 'PASS' | 'FAIL';

export interface TextUsabilityMetrics {
  characterCount: number;
  nonWhitespaceCharacters: number;
  charsPerPage: number | null;
  alphanumericRatio: number;
  garbageRatio: number;
  repeatedArtifactRatio: number;
  emptyPageRatio: number | null;
}

export interface TextUsabilityResult {
  usable: boolean;
  metrics: TextUsabilityMetrics;
  reasons: string[];
}

const GARBAGE_CHAR_PATTERN = /[\uFFFD|_~^`{}[\]\\<>]/g;
const REPEATED_ARTIFACT_LINE_PATTERN = /^([|Il1_\-=\s])\1{7,}$/;

export function computeTextUsabilityMetrics(text: string, pageCount: number | null): TextUsabilityMetrics {
  const nonWhitespaceCharacters = (text.match(/\S/g) ?? []).length;
  const alphanumericCharacters = (text.match(/[A-Za-z0-9]/g) ?? []).length;
  const garbageCharacters = (text.match(GARBAGE_CHAR_PATTERN) ?? []).length;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const artifactLines = lines.filter((line) => REPEATED_ARTIFACT_LINE_PATTERN.test(line)).length;
  const pages = text.split(/\f/g);
  const emptyPages = pages.filter((page) => (page.match(/\S/g) ?? []).length === 0).length;

  return {
    characterCount: text.length,
    nonWhitespaceCharacters,
    charsPerPage: pageCount && pageCount > 0 ? nonWhitespaceCharacters / pageCount : null,
    alphanumericRatio: nonWhitespaceCharacters > 0 ? alphanumericCharacters / nonWhitespaceCharacters : 0,
    garbageRatio: nonWhitespaceCharacters > 0 ? garbageCharacters / nonWhitespaceCharacters : 0,
    repeatedArtifactRatio: lines.length > 0 ? artifactLines / lines.length : 0,
    emptyPageRatio: pageCount && pageCount > 0 ? emptyPages / pageCount : null,
  };
}

export function isNativeTextUsable(
  text: string,
  pageCount: number | null,
  config: Pick<OcrConfig, 'minNativeCharacters' | 'minNativeCharsPerPage'>,
): TextUsabilityResult {
  const metrics = computeTextUsabilityMetrics(text, pageCount);
  const reasons: string[] = [];

  if (metrics.nonWhitespaceCharacters < config.minNativeCharacters) {
    reasons.push('TEXT_TOO_SHORT');
  }
  if (
    metrics.charsPerPage !== null &&
    metrics.charsPerPage < config.minNativeCharsPerPage
  ) {
    reasons.push('TEXT_TOO_SPARSE_PER_PAGE');
  }

  return {
    usable: reasons.length === 0,
    metrics,
    reasons,
  };
}

export function validateOcrTextQuality(
  text: string,
  pageCount: number | null,
  config: Pick<
    OcrConfig,
    | 'minOcrCharacters'
    | 'minOcrCharsPerPage'
    | 'minAlphanumericRatio'
    | 'maxGarbageRatio'
    | 'maxRepeatedArtifactRatio'
  >,
): TextUsabilityResult {
  const metrics = computeTextUsabilityMetrics(text, pageCount);
  const reasons: string[] = [];

  if (metrics.nonWhitespaceCharacters < config.minOcrCharacters) {
    reasons.push('OCR_TEXT_TOO_SHORT');
  }
  if (metrics.charsPerPage !== null && metrics.charsPerPage < config.minOcrCharsPerPage) {
    reasons.push('OCR_TEXT_TOO_SPARSE_PER_PAGE');
  }
  if (metrics.alphanumericRatio < config.minAlphanumericRatio) {
    reasons.push('OCR_LOW_ALPHANUMERIC_RATIO');
  }
  if (metrics.garbageRatio > config.maxGarbageRatio) {
    reasons.push('OCR_HIGH_GARBAGE_RATIO');
  }
  if (metrics.repeatedArtifactRatio > config.maxRepeatedArtifactRatio) {
    reasons.push('OCR_REPEATED_ARTIFACTS');
  }

  return {
    usable: reasons.length === 0,
    metrics,
    reasons,
  };
}
