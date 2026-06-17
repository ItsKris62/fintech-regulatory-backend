import type { SearchResult } from '@/lib/rag/rag.service';
import { logger } from '@/utils/logger';

export type ClaimVerificationStatus = 'supported' | 'unsupported' | 'not_required';
export type ClaimVerificationVerdict = 'PASS' | 'PARTIAL' | 'FAIL';

export type AnswerClaimVerification = {
  claimText: string;
  claimType: 'legal_obligation' | 'deadline' | 'penalty' | 'definition' | 'authority' | 'general';
  requiresCitation: boolean;
  status: ClaimVerificationStatus;
  confidence: number;
  supportingChunk?: SearchResult;
  quoteStart?: number;
  quoteEnd?: number;
  supportExcerpt?: string;
};

export type AnswerVerificationResult = {
  verdict: ClaimVerificationVerdict;
  claims: AnswerClaimVerification[];
  unsupportedClaims: AnswerClaimVerification[];
  supportedClaims: AnswerClaimVerification[];
};

const CLAIM_SENTENCE_LIMIT = 80;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'if', 'in',
  'into', 'is', 'it', 'its', 'may', 'must', 'of', 'on', 'or', 'shall', 'should', 'that', 'the',
  'their', 'this', 'to', 'under', 'with', 'within', 'you', 'your',
]);

const LEGAL_SIGNAL = /\b(shall|must|required|requires|requirement|obligation|prohibited|may not|deadline|within\s+\d+|penalt(?:y|ies)|fine|liable|licen[cs]e|approval|consent|notify|report|submit|register|regulator|authority|act|regulation|guideline|section|article|rule|compliance|non-compliance|binding)\b/i;
const DEADLINE_SIGNAL = /\b(within|not later than|before|after|days?|months?|annually|quarterly|immediately)\b/i;
const PENALTY_SIGNAL = /\b(penalt(?:y|ies)|fine|imprisonment|liable|offence|sanction)\b/i;
const DEFINITION_SIGNAL = /\b(means|defined as|definition|refers to)\b/i;
const AUTHORITY_SIGNAL = /\b(CBK|Central Bank|ODPC|Data Commissioner|CMA|SASRA|IRA|regulator|authority)\b/i;

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[[^\]]+\]\([^)]+\)/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractAnswerClaims(answer: string): AnswerClaimVerification[] {
  const cleaned = stripMarkdown(answer);
  if (!cleaned) return [];

  const sentences = cleaned
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 24)
    .slice(0, CLAIM_SENTENCE_LIMIT);

  return sentences.map((claimText) => {
    const claimType: AnswerClaimVerification['claimType'] =
      PENALTY_SIGNAL.test(claimText) ? 'penalty' :
      DEADLINE_SIGNAL.test(claimText) ? 'deadline' :
      DEFINITION_SIGNAL.test(claimText) ? 'definition' :
      AUTHORITY_SIGNAL.test(claimText) ? 'authority' :
      LEGAL_SIGNAL.test(claimText) ? 'legal_obligation' :
      'general';

    const requiresCitation = claimType !== 'general' || LEGAL_SIGNAL.test(claimText);

    return {
      claimText,
      claimType,
      requiresCitation,
      status: requiresCitation ? 'unsupported' : 'not_required',
      confidence: requiresCitation ? 0 : 1,
    };
  });
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function candidateExcerpts(chunkText: string): Array<{ text: string; start: number; end: number }> {
  const sentences = chunkText
    .split(/(?<=[.!?])\s+/)
    .map((text) => text.trim())
    .filter(Boolean);

  if (sentences.length === 0) {
    return [{ text: chunkText.slice(0, 500), start: 0, end: Math.min(chunkText.length, 500) }];
  }

  const excerpts: Array<{ text: string; start: number; end: number }> = [];
  let cursor = 0;

  for (const sentence of sentences) {
    const start = chunkText.indexOf(sentence, cursor);
    const safeStart = start >= 0 ? start : cursor;
    const end = safeStart + sentence.length;
    excerpts.push({ text: sentence, start: safeStart, end });
    cursor = end;
  }

  return excerpts;
}

function supportScore(claim: string, excerpt: string): number {
  const claimTokens = new Set(tokenize(claim));
  const excerptTokens = new Set(tokenize(excerpt));
  if (claimTokens.size === 0 || excerptTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of claimTokens) {
    if (excerptTokens.has(token)) overlap++;
  }

  const ratio = overlap / claimTokens.size;
  const numericClaimTokens = [...claimTokens].filter((token) => /\d/.test(token));
  const numericCovered = numericClaimTokens.every((token) => excerptTokens.has(token));
  const numericPenalty = numericClaimTokens.length > 0 && !numericCovered ? 0.2 : 0;

  return Math.max(0, ratio - numericPenalty);
}

function findBestSupport(
  claim: AnswerClaimVerification,
  chunks: SearchResult[],
): Pick<AnswerClaimVerification, 'supportingChunk' | 'quoteStart' | 'quoteEnd' | 'supportExcerpt' | 'confidence'> {
  let best:
    | (Pick<AnswerClaimVerification, 'supportingChunk' | 'quoteStart' | 'quoteEnd' | 'supportExcerpt' | 'confidence'>)
    | null = null;

  for (const chunk of chunks) {
    for (const excerpt of candidateExcerpts(chunk.chunkText || '')) {
      const confidence = supportScore(claim.claimText, excerpt.text);
      if (!best || confidence > best.confidence) {
        best = {
          supportingChunk: chunk,
          quoteStart: excerpt.start,
          quoteEnd: excerpt.end,
          supportExcerpt: excerpt.text.slice(0, 500),
          confidence,
        };
      }
    }
  }

  return best ?? { confidence: 0 };
}

export function verifyAnswerClaims(
  answer: string,
  acceptedChunks: SearchResult[],
): AnswerVerificationResult {
  const claims = extractAnswerClaims(answer).map((claim) => {
    if (!claim.requiresCitation) return claim;

    const support = findBestSupport(claim, acceptedChunks);
    const supported = support.confidence >= 0.45;

    const status: ClaimVerificationStatus = supported ? 'supported' : 'unsupported';

    return {
      ...claim,
      ...support,
      status,
      confidence: support.confidence,
    };
  });

  const unsupportedClaims = claims.filter((claim) => claim.requiresCitation && claim.status !== 'supported');
  const supportedClaims = claims.filter((claim) => claim.requiresCitation && claim.status === 'supported');
  const requiredClaims = claims.filter((claim) => claim.requiresCitation);

  const verdict: ClaimVerificationVerdict =
    unsupportedClaims.length === 0 ? 'PASS' :
    supportedClaims.length > 0 ? 'PARTIAL' :
    requiredClaims.length > 0 ? 'FAIL' :
    'PASS';

  return { verdict, claims, unsupportedClaims, supportedClaims };
}

export async function persistClaimVerification(
  prisma: unknown,
  complianceQueryId: string,
  result: AnswerVerificationResult,
): Promise<void> {
  const client = prisma as unknown as {
    complianceAnswerClaim?: {
      deleteMany: (args: unknown) => Promise<unknown>;
      create: (args: unknown) => Promise<{ id: string }>;
    };
    complianceClaimCitation?: {
      create: (args: unknown) => Promise<unknown>;
    };
  };

  if (!client.complianceAnswerClaim || !client.complianceClaimCitation) {
    logger.warn({
      type: 'claim_verification_tables_unavailable',
      complianceQueryId,
      claims: result.claims.length,
    });
    return;
  }

  await client.complianceAnswerClaim.deleteMany({ where: { complianceQueryId } });

  for (const claim of result.claims) {
    const savedClaim = await client.complianceAnswerClaim.create({
      data: {
        complianceQueryId,
        claimText: claim.claimText,
        claimType: claim.claimType,
        requiresCitation: claim.requiresCitation,
        status: claim.status,
        confidence: claim.confidence,
      },
    });

    if (claim.supportingChunk && claim.supportExcerpt) {
      await client.complianceClaimCitation.create({
        data: {
          claimId: savedClaim.id,
          regulatoryDocumentChunkId: null,
          documentId: claim.supportingChunk.documentId ?? null,
          documentTitle: claim.supportingChunk.documentTitle,
          section: claim.supportingChunk.section ?? null,
          chunkRank: claim.supportingChunk.rank ?? null,
          quoteStart: claim.quoteStart ?? null,
          quoteEnd: claim.quoteEnd ?? null,
          supportExcerpt: claim.supportExcerpt,
          supportVerdict: claim.status === 'supported' ? 'supported' : 'unsupported',
          confidence: claim.confidence,
          verifierModel: 'deterministic-lexical-v1',
          rawSource: claim.supportingChunk,
        },
      });
    }
  }
}
