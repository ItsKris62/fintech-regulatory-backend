export interface OcrConfig {
  enabled: boolean;
  engine: 'ocrmypdf';
  command: string;
  commandArgs: string[];
  pathPrefix?: string;
  minNativeCharacters: number;
  minNativeCharsPerPage: number;
  minOcrCharacters: number;
  minOcrCharsPerPage: number;
  minAlphanumericRatio: number;
  maxGarbageRatio: number;
  maxRepeatedArtifactRatio: number;
  versionTimeoutMs: number;
  timeoutMs: number;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function getOcrConfig(): OcrConfig {
  const command = process.env.OCR_COMMAND?.trim() || 'ocrmypdf';
  return {
    enabled: process.env.OCR_ENABLED !== 'false',
    engine: 'ocrmypdf',
    command,
    commandArgs: command === 'py' ? ['-m', 'ocrmypdf'] : [],
    pathPrefix: process.env.OCR_PATH_PREFIX?.trim() || undefined,
    minNativeCharacters: numberFromEnv('OCR_MIN_NATIVE_CHARACTERS', 100),
    minNativeCharsPerPage: numberFromEnv('OCR_MIN_NATIVE_CHARS_PER_PAGE', 10),
    minOcrCharacters: numberFromEnv('OCR_MIN_OUTPUT_CHARACTERS', 100),
    minOcrCharsPerPage: numberFromEnv('OCR_MIN_CHARS_PER_PAGE', 25),
    minAlphanumericRatio: numberFromEnv('OCR_MIN_ALPHANUMERIC_RATIO', 0.55),
    maxGarbageRatio: numberFromEnv('OCR_MAX_GARBAGE_RATIO', 0.08),
    maxRepeatedArtifactRatio: numberFromEnv('OCR_MAX_REPEATED_ARTIFACT_RATIO', 0.2),
    versionTimeoutMs: numberFromEnv('OCR_VERSION_TIMEOUT_MS', 30_000),
    timeoutMs: numberFromEnv('OCR_TIMEOUT_MS', 180_000),
  };
}
