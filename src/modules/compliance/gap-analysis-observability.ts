import { Prisma } from '@prisma/client';
import { SourceInsufficiencyError } from '@/lib/source-grounding/source-insufficiency';
import { isGapAnalysisCancelledError } from './gap-analysis-cancellation';

export type GapAnalysisFailureClass =
  | 'VALIDATION'
  | 'ENTITLEMENT'
  | 'MALWARE'
  | 'SOURCE_INSUFFICIENCY'
  | 'RAG_SERVICE'
  | 'AI_PROVIDER'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'STORAGE'
  | 'DATABASE'
  | 'INTERNAL';

export function classifyGapAnalysisFailure(error: unknown): { failureClass: GapAnalysisFailureClass; retryable: boolean } {
  if (error instanceof SourceInsufficiencyError) return { failureClass: 'SOURCE_INSUFFICIENCY', retryable: false };
  if (isGapAnalysisCancelledError(error)) return { failureClass: 'CANCELLED', retryable: false };
  const named = error as { name?: string; code?: string; retryable?: boolean };
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (named.name === 'MalwareDetectedError') return { failureClass: 'MALWARE', retryable: false };
  if (named.code && /^P\d{4}$/.test(named.code)) return { failureClass: 'DATABASE', retryable: named.code === 'P2034' || named.code === 'P2028' };
  if (error instanceof Prisma.PrismaClientKnownRequestError) return { failureClass: 'DATABASE', retryable: false };
  if (/cancel/.test(message)) return { failureClass: 'CANCELLED', retryable: false };
  if (/deadline|timed? out|timeout/.test(message)) return { failureClass: 'TIMEOUT', retryable: true };
  if (/forbidden|entitlement|plan|limit reached|quota/.test(message)) return { failureClass: 'ENTITLEMENT', retryable: false };
  if (/invalid|unsupported|too large|extract meaningful|ocr_required/.test(message)) return { failureClass: 'VALIDATION', retryable: false };
  if (/pinecone|retrieval|rag service|embedding/.test(message)) return { failureClass: 'RAG_SERVICE', retryable: true };
  if (/provider|anthropic|gemini|openai|model/.test(message)) return { failureClass: 'AI_PROVIDER', retryable: named.retryable ?? true };
  if (/storage|r2|object|upload|download/.test(message)) return { failureClass: 'STORAGE', retryable: true };
  return { failureClass: 'INTERNAL', retryable: named.retryable ?? false };
}
