import type { SearchResult } from '@/lib/rag/rag.service';
import { logger } from '@/utils/logger';
import type { JurisdictionCode } from '@/types/jurisdiction';

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
const MAX_CLAIM_CHARS = 360;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'if', 'in',
  'into', 'is', 'it', 'its', 'may', 'must', 'of', 'on', 'or', 'shall', 'should', 'that', 'the',
  'their', 'this', 'to', 'under', 'with', 'within', 'you', 'your',
  'available', 'based', 'corpus', 'evidence', 'retrieved',
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

function normalizeHeading(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .trim()
    .toLowerCase();
}

function isNonClaimHeading(line: string): boolean {
  const heading = normalizeHeading(line);
  return [
    'referenced documents and sections',
    'references',
    'source status',
    'next steps',
    'practical next steps',
    'implementation steps',
    'recommended controls',
    'limitations',
  ].includes(heading);
}

function isSectionHeading(line: string): boolean {
  return /^#{1,6}\s+\S+/.test(line.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function cleanClaimCandidate(text: string): string {
  return text
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+\.\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[[^\]]+\]\([^)]+\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitCandidateSentences(text: string): string[] {
  const cleaned = cleanClaimCandidate(text);
  if (!cleaned) return [];

  const sentenceParts = cleaned
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .flatMap((part) => part.length > MAX_CLAIM_CHARS ? part.split(/\s*;\s+/) : [part])
    .map((part) => part.trim())
    .filter(Boolean);

  return sentenceParts.flatMap((part) => {
    if (part.length <= MAX_CLAIM_CHARS) return [part];
    const colonParts = part.split(/\s+(?=[A-Z][A-Za-z ]{2,40}:)/);
    return colonParts.length > 1 ? colonParts : [part.slice(0, MAX_CLAIM_CHARS)];
  });
}

function extractClaimCandidates(answer: string): string[] {
  const withoutCode = answer.replace(/```[\s\S]*?```/g, ' ');
  const lines = withoutCode.split(/\r?\n/);
  const candidates: string[] = [];
  let skipSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (isSectionHeading(line)) {
      skipSection = isNonClaimHeading(line);
      if (skipSection || ['direct answer', 'key obligations', 'executive summary', 'applicable legal context', 'compliance obligations'].includes(normalizeHeading(line))) {
        continue;
      }
    }

    if (skipSection || isTableSeparator(line)) continue;

    if (line.includes('|')) {
      const cells = line
        .split('|')
        .map((cell) => cleanClaimCandidate(cell))
        .filter((cell) => cell && !/^[-: ]+$/.test(cell));
      for (const cell of cells) candidates.push(...splitCandidateSentences(cell));
      continue;
    }

    candidates.push(...splitCandidateSentences(line));
  }

  if (candidates.length > 0) return candidates;

  const cleaned = stripMarkdown(answer);
  if (!cleaned) return [];
  return splitCandidateSentences(cleaned);
}

function isOperationalRecommendation(claimText: string): boolean {
  return /\b(recommendation|recommend|engage counsel|legal counsel|obtain.*legal opinion|request.*guidance|prepare|map all|conduct an audit|maintain records of correspondence)\b/i.test(claimText);
}

function isCorpusLimitation(claimText: string): boolean {
  return /\b(corpus does not contain|available regulatory corpus does not|retrieved corpus does not|retrieved evidence does not|available evidence does not|regulatory corpus is insufficient|not included in the retrieved evidence|insufficient information)\b/i.test(claimText);
}

function isStructuralFragment(claimText: string): boolean {
  return /:\s*$/.test(claimText);
}

export function extractAnswerClaims(answer: string): AnswerClaimVerification[] {
  const sentences = extractClaimCandidates(answer)
    .filter((sentence) => sentence.length >= 24)
    .slice(0, CLAIM_SENTENCE_LIMIT);

  let previousActor: string | null = null;

  return sentences.map((rawClaimText) => {
    const actorMatch = rawClaimText.match(/\b(data controllers? and data processors?|payment service providers?|financial institutions?|digital credit providers?|banks?|microfinance institutions?)\b/i);
    const claimText = previousActor
      ? rawClaimText.replace(/\b(these actors|those actors|these entities|such entities)\b/gi, previousActor)
      : rawClaimText;
    if (actorMatch) previousActor = actorMatch[1];

    const claimType: AnswerClaimVerification['claimType'] =
      PENALTY_SIGNAL.test(claimText) ? 'penalty' :
      DEADLINE_SIGNAL.test(claimText) ? 'deadline' :
      DEFINITION_SIGNAL.test(claimText) ? 'definition' :
      AUTHORITY_SIGNAL.test(claimText) ? 'authority' :
      LEGAL_SIGNAL.test(claimText) ? 'legal_obligation' :
      'general';

    const requiresCitation =
      !isStructuralFragment(claimText) &&
      !isOperationalRecommendation(claimText) &&
      !isCorpusLimitation(claimText) &&
      (claimType !== 'general' || LEGAL_SIGNAL.test(claimText));

    return {
      claimText,
      claimType,
      requiresCitation,
      status: requiresCitation ? 'unsupported' : 'not_required',
      confidence: requiresCitation ? 0 : 1,
    };
  });
}

function canonicalizeToken(token: string): string {
  const replacements: Record<string, string> = {
    licenced: 'license',
    licence: 'license',
    licences: 'license',
    licensed: 'license',
    licensing: 'license',
    licenses: 'license',
    requirements: 'requirement',
    required: 'require',
    requires: 'require',
    obligations: 'obligation',
    obligated: 'obligation',
    providers: 'provider',
    services: 'service',
    systems: 'system',
    controllers: 'controller',
    processors: 'processor',
    processing: 'process',
    processed: 'process',
    transfers: 'transfer',
    transferred: 'transfer',
    regulations: 'regulation',
    guidelines: 'guideline',
    authorities: 'authority',
    payments: 'payment',
    fintechs: 'fintech',
    companies: 'company',
    records: 'record',
    keeping: 'keep',
    commencing: 'commence',
    business: 'business',
  };
  if (replacements[token]) return replacements[token];
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('ing') && token.length > 5) return token.slice(0, -3);
  if (token.endsWith('ed') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('s') && token.length > 4) return token.slice(0, -1);
  return token;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .map(canonicalizeToken)
    .filter((token) => (token.length >= 3 || /\d/.test(token)) && !STOPWORDS.has(token));
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

  for (let i = 0; i < sentences.length - 1; i++) {
    const text = `${sentences[i]} ${sentences[i + 1]}`;
    const start = chunkText.indexOf(sentences[i]);
    const end = start >= 0 ? start + text.length : Math.min(chunkText.length, text.length);
    excerpts.push({ text, start: Math.max(0, start), end: Math.min(chunkText.length, end) });
  }

  excerpts.push({ text: chunkText.slice(0, 700), start: 0, end: Math.min(chunkText.length, 700) });

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

function hasNumericMismatch(claim: string, excerpt: string): boolean {
  const claimTokens = new Set(tokenize(claim));
  const excerptTokens = new Set(tokenize(excerpt));
  const numericClaimTokens = [...claimTokens].filter((token) => /\d/.test(token));
  return numericClaimTokens.length > 0 && !numericClaimTokens.every((token) => excerptTokens.has(token));
}

function overlapCount(claim: string, excerpt: string): number {
  const claimTokens = new Set(tokenize(claim));
  const excerptTokens = new Set(tokenize(excerpt));
  let overlap = 0;
  for (const token of claimTokens) {
    if (excerptTokens.has(token)) overlap++;
  }
  return overlap;
}

function searchableSupportText(support: Pick<AnswerClaimVerification, 'supportingChunk' | 'supportExcerpt'>): string {
  const chunk = support.supportingChunk;
  return [
    chunk?.documentTitle,
    chunk?.section,
    chunk?.sectionNumber,
    support.supportExcerpt,
  ].filter(Boolean).join(' ');
}

function explicitClaimJurisdiction(claimText: string): JurisdictionCode | null {
  if (/\b(kenya|kenyan|central bank of kenya|cbk|odpc)\b/i.test(claimText)) return 'KE';
  if (/\b(rwanda|rwandan|national bank of rwanda|bnr|nbr)\b/i.test(claimText)) return 'RW';
  if (/\b(malawi|malawian|malawi communications regulatory authority)\b/i.test(claimText)) return 'MW';
  if (/\b(nigeria|nigerian|central bank of nigeria|cbn)\b/i.test(claimText)) return 'NG';
  return null;
}

function chunkCanSupportClaim(claim: AnswerClaimVerification, chunk: SearchResult): boolean {
  const claimJurisdiction = explicitClaimJurisdiction(claim.claimText);
  return !claimJurisdiction || chunk.jurisdictionCode === claimJurisdiction;
}

function isBorderlineSupported(
  claim: AnswerClaimVerification,
  support: Pick<AnswerClaimVerification, 'supportingChunk' | 'supportExcerpt' | 'confidence'>,
): boolean {
  if (!support.supportingChunk || !support.supportExcerpt) return false;
  if (support.confidence < 0.4) return false;

  const evidenceText = searchableSupportText(support);
  if (hasNumericMismatch(claim.claimText, evidenceText)) return false;

  return overlapCount(claim.claimText, evidenceText) >= 5;
}

function findBestSupport(
  claim: AnswerClaimVerification,
  chunks: SearchResult[],
): Pick<AnswerClaimVerification, 'supportingChunk' | 'quoteStart' | 'quoteEnd' | 'supportExcerpt' | 'confidence'> {
  let best:
    | (Pick<AnswerClaimVerification, 'supportingChunk' | 'quoteStart' | 'quoteEnd' | 'supportExcerpt' | 'confidence'>)
    | null = null;

  for (const chunk of chunks) {
    if (!chunkCanSupportClaim(claim, chunk)) continue;
    for (const excerpt of candidateExcerpts(chunk.chunkText || '')) {
      const searchableExcerpt = [
        chunk.documentTitle,
        chunk.section,
        chunk.sectionNumber,
        excerpt.text,
      ].filter(Boolean).join(' ');
      const confidence = supportScore(claim.claimText, searchableExcerpt);
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
    const evidenceText = searchableSupportText(support);
    const numericMismatch = hasNumericMismatch(claim.claimText, evidenceText);
    const supported = !numericMismatch && (support.confidence >= 0.45 || isBorderlineSupported(claim, support));

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
