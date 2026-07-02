import { appConfig } from '@/config/app.config';
import { aiConfig } from '@/config/ai.config';
import { llmGateway as defaultLlmGateway } from '@/lib/ai/gateway/llm-gateway';
import type { LLMCompletionRequest, LLMCompletionResult } from '@/lib/ai/gateway/types';
import { calculateCost } from '@/lib/ai/gateway/pricing';
import { logger } from '@/utils/logger';
import type {
  ClassifiedSignalCore,
  ProviderUsage,
  RawRegulatorySourceItem,
  RegulatoryDocumentType,
  RegulatorySeverity,
  ScannedSignalCandidate,
} from './types';
import { asNullableInteger, asNullableString, asStringArray, extractJsonObject, sanitizeRawContent } from './utils';

interface GatewayLike {
  complete(req: LLMCompletionRequest): Promise<LLMCompletionResult>;
}

export interface SignalClassifierDependencies {
  llmGateway?: GatewayLike;
}

interface ScanResponseItem {
  sourceItemId: string;
  isRegulatory: boolean;
  jurisdiction: string;
  regulatoryBody: string;
  documentType: RegulatoryDocumentType;
  confidence: number;
  reason: string;
}

interface DeepAnalysisResponse {
  title: string;
  summary: string;
  affectedSectors: string[];
  affectedObligations: string[];
  severityLevel: RegulatorySeverity;
  effectiveDate: string | null;
  complianceWindowDays: number | null;
  referencedFrameworks: string[];
}

const DOCUMENT_TYPES: readonly RegulatoryDocumentType[] = ['guideline', 'notice', 'amendment', 'consultation', 'enforcement', 'gazette', 'other'];
const SEVERITIES: readonly RegulatorySeverity[] = ['critical', 'high', 'medium', 'low', 'informational'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function documentTypeFrom(value: unknown): RegulatoryDocumentType {
  return typeof value === 'string' && DOCUMENT_TYPES.includes(value as RegulatoryDocumentType) ? value as RegulatoryDocumentType : 'other';
}

function severityFrom(value: unknown): RegulatorySeverity {
  return typeof value === 'string' && SEVERITIES.includes(value as RegulatorySeverity) ? value as RegulatorySeverity : 'informational';
}

function usageFrom(result: LLMCompletionResult): ProviderUsage {
  return {
    provider: result.provider,
    model: result.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: calculateCost(result.provider, result.model, result.usage.inputTokens, result.usage.outputTokens).cost,
  };
}

function parseScanResponse(parsed: unknown): ScanResponseItem[] {
  const rawItems = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.items)
      ? parsed.items
      : [];

  return rawItems.filter(isRecord).map((item) => ({
    sourceItemId: typeof item.sourceItemId === 'string' ? item.sourceItemId : '',
    isRegulatory: item.isRegulatory === true,
    jurisdiction: typeof item.jurisdiction === 'string' ? item.jurisdiction : 'UNKNOWN',
    regulatoryBody: typeof item.regulatoryBody === 'string' ? item.regulatoryBody : 'UNKNOWN',
    documentType: documentTypeFrom(item.documentType),
    confidence: typeof item.confidence === 'number' ? item.confidence : 0,
    reason: typeof item.reason === 'string' ? item.reason : 'No reason provided.',
  })).filter((item) => item.sourceItemId.length > 0);
}

function parseDeepAnalysisResponse(parsed: unknown): DeepAnalysisResponse {
  if (!isRecord(parsed)) {
    throw new Error('Deep analysis response was not a JSON object.');
  }

  return {
    title: asNullableString(parsed.title) ?? 'Untitled regulatory signal',
    summary: asNullableString(parsed.summary) ?? 'No summary provided.',
    affectedSectors: asStringArray(parsed.affectedSectors),
    affectedObligations: asStringArray(parsed.affectedObligations),
    severityLevel: severityFrom(parsed.severityLevel),
    effectiveDate: asNullableString(parsed.effectiveDate),
    complianceWindowDays: asNullableInteger(parsed.complianceWindowDays),
    referencedFrameworks: asStringArray(parsed.referencedFrameworks),
  };
}

function scanPrompt(items: RawRegulatorySourceItem[]): string {
  return JSON.stringify({
    task: 'Classify source items as regulatory or non-regulatory. Return JSON only with { items: [...] }.',
    schema: {
      sourceItemId: 'string',
      isRegulatory: 'boolean',
      jurisdiction: 'KE|MW|RW|NG|REGIONAL|GLOBAL',
      regulatoryBody: 'CBK|ODPC|CMA|CA|RBM|BNR|CBN|NDPC|SEC|NCC|other',
      documentType: DOCUMENT_TYPES,
      confidence: 'number 0..1',
      reason: 'short string',
    },
    items: items.map((item) => ({
      sourceItemId: item.id,
      title: item.title,
      url: item.url,
      summary: item.summary,
      jurisdiction: item.jurisdiction,
      authorityType: item.authorityType,
      monitorName: item.monitorName,
      publicationDate: item.publicationDate?.toISOString() ?? null,
    })),
  });
}

function deepPrompt(candidate: ScannedSignalCandidate): string {
  const item = candidate.sourceItem;
  return JSON.stringify({
    task: 'Analyze this regulatory source for fintech compliance impact. Return JSON only.',
    schema: {
      title: 'string',
      summary: 'plain English summary',
      affectedSectors: ['payments', 'digital-lending', 'data-protection'],
      affectedObligations: ['licensing', 'reporting', 'consumer disclosure'],
      severityLevel: SEVERITIES,
      effectiveDate: 'ISO date or null',
      complianceWindowDays: 'integer or null',
      referencedFrameworks: ['framework/document names that should exist in the corpus'],
    },
    source: {
      sourceItemId: item.id,
      title: item.title,
      url: item.url,
      summary: item.summary,
      jurisdiction: candidate.jurisdiction,
      regulatoryBody: candidate.regulatoryBody,
      documentType: candidate.documentType,
      monitorName: item.monitorName,
      publicationDate: item.publicationDate?.toISOString() ?? null,
    },
  });
}

export class SignalClassifierService {
  private readonly llmGateway: GatewayLike;

  constructor(dependencies: SignalClassifierDependencies = {}) {
    this.llmGateway = dependencies.llmGateway ?? defaultLlmGateway;
  }

  async scanItems(agentRunId: string, items: RawRegulatorySourceItem[]): Promise<{ candidates: ScannedSignalCandidate[]; usage: ProviderUsage | null }> {
    if (items.length === 0) return { candidates: [], usage: null };

    const result = await this.llmGateway.complete({
      provider: 'gemini',
      model: appConfig.gemini.model,
      allowFallback: false,
      useCase: 'analysis',
      temperature: 0,
      maxTokens: 2000,
      systemPrompt: 'You are a high-volume regulatory source scanning classifier. Return compact JSON only.',
      prompt: scanPrompt(items),
    });

    const scanItemsResponse = parseScanResponse(extractJsonObject(result.content));
    const byId = new Map(items.map((item) => [item.id, item]));
    const candidates = scanItemsResponse
      .map((scanItem) => {
        const sourceItem = byId.get(scanItem.sourceItemId);
        if (!sourceItem) return null;
        return {
          sourceItem,
          isRegulatory: scanItem.isRegulatory,
          jurisdiction: scanItem.jurisdiction,
          regulatoryBody: scanItem.regulatoryBody,
          documentType: scanItem.documentType,
          confidence: scanItem.confidence,
          reason: scanItem.reason,
        } satisfies ScannedSignalCandidate;
      })
      .filter((item): item is ScannedSignalCandidate => item !== null && item.isRegulatory);

    logger.info({ type: 'reg_intel_signal_scanned', agentRunId, provider: result.provider, model: result.model, candidates: candidates.length });
    return { candidates, usage: usageFrom(result) };
  }

  async deepAnalyze(agentRunId: string, candidates: ScannedSignalCandidate[], scanningUsage: ProviderUsage | null): Promise<{ signals: ClassifiedSignalCore[]; usage: ProviderUsage[] }> {
    const signals: ClassifiedSignalCore[] = [];
    const usage: ProviderUsage[] = [];

    for (const candidate of candidates) {
      const result = await this.llmGateway.complete({
        provider: 'anthropic',
        model: aiConfig.models.complexAnalysis,
        allowFallback: false,
        useCase: 'analysis',
        temperature: 0.1,
        maxTokens: 2500,
        systemPrompt: 'You are a senior East African fintech regulatory analyst. Return structured JSON only.',
        prompt: deepPrompt(candidate),
      });

      const analysis = parseDeepAnalysisResponse(extractJsonObject(result.content));
      usage.push(usageFrom(result));
      signals.push({
        sourceItem: candidate.sourceItem,
        sourceUrl: candidate.sourceItem.url,
        normalizedUrl: candidate.sourceItem.normalizedUrl,
        contentHash: candidate.sourceItem.contentHash,
        jurisdiction: analysis.title ? candidate.jurisdiction : candidate.sourceItem.jurisdiction,
        regulatoryBody: candidate.regulatoryBody,
        documentType: candidate.documentType,
        title: analysis.title,
        summary: analysis.summary,
        affectedSectors: analysis.affectedSectors,
        affectedObligations: analysis.affectedObligations,
        severityLevel: analysis.severityLevel,
        effectiveDate: analysis.effectiveDate,
        complianceWindowDays: analysis.complianceWindowDays,
        referencedFrameworks: analysis.referencedFrameworks,
        rawContent: sanitizeRawContent(`${candidate.sourceItem.title}\n${candidate.sourceItem.summary ?? ''}`),
        providerTrace: {
          scanningProvider: 'gemini',
          analysisProvider: 'anthropic',
          scanningModel: scanningUsage?.model ?? appConfig.gemini.model,
          analysisModel: result.model,
        },
      });

      logger.info({ type: 'reg_intel_signal_classified', agentRunId, provider: result.provider, model: result.model, sourceItemId: candidate.sourceItem.id });
    }

    return { signals, usage };
  }
}

export const signalClassifierService = new SignalClassifierService();