import { complete } from '@/lib/ai/client';
import { logger } from '@/utils/logger';
import { extractJson } from './utils';
import type { AgentTokens, OrchestratorRoute } from './types';

export interface RouterAgentResult {
  route: OrchestratorRoute;
  confidence: number;
  subQuestions: string[];
  tokens: AgentTokens;
  parseFailed: boolean;
}

const VALID_ROUTES: OrchestratorRoute[] = ['simple', 'complex', 'abstain'];

const SYSTEM = `You are a query router for SheriaBot, a Kenyan financial-services compliance assistant.
Classify the user's compliance question into exactly one route:
- "simple"  : single-regulation lookup, specific numeric threshold, or definition question
- "complex" : requires synthesising multiple regulations, multi-step procedural guidance, or cross-jurisdictional analysis
- "abstain" : question is outside Kenyan fintech / financial-services regulatory scope

Important: an unknown, imaginary, or unverified named regulation inside an otherwise Kenyan fintech,
banking, payments, lending, data protection, AML/CFT, tax, company, or capital markets compliance
question is not "abstain". Route it as "simple" or "complex" so source verification can decide whether
the named regulation is supported by the corpus.

Respond with a single JSON object:
{
  "route": "simple"|"complex"|"abstain",
  "confidence": <float 0.0–1.0 indicating certainty in the route decision>,
  "reason": "<one sentence>",
  "subQuestions": ["<sub-question 1>", "..."]
}

subQuestions should contain the discrete sub-questions that must be answered to fully address the query.
For "simple" and "abstain" routes, subQuestions should be an empty array [].
No markdown, no other text outside the JSON object.`;

export async function runRouterAgent(question: string): Promise<RouterAgentResult> {
  try {
    const result = await complete(
      { prompt: question, systemPrompt: SYSTEM, maxTokens: 500, temperature: 0.0 },
      'query'
    );

    const tokens: AgentTokens = { input: result.inputTokens, output: result.outputTokens };

    try {
      const parsed = JSON.parse(extractJson(result.content)) as {
        route?: string;
        confidence?: number;
        reason?: string;
        subQuestions?: unknown[];
      };

      const routeCandidate = parsed.route ?? '';
      const isValidRoute = (VALID_ROUTES as string[]).includes(routeCandidate);
      const route: OrchestratorRoute = isValidRoute ? (routeCandidate as OrchestratorRoute) : 'simple';

      const confidence =
        typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
          ? parsed.confidence
          : isValidRoute ? 0.7 : 0.5; // fallback sentinels

      const subQuestions = Array.isArray(parsed.subQuestions)
        ? (parsed.subQuestions as unknown[]).filter((q): q is string => typeof q === 'string')
        : [];

      logger.debug({
        type: 'router_agent_result',
        route,
        confidence,
        subQuestions: subQuestions.length,
        reason: parsed.reason,
        parseFallback: !isValidRoute,
      });

      return { route, confidence, subQuestions, tokens, parseFailed: !isValidRoute };
    } catch {
      logger.warn({ type: 'router_agent_parse_failed', contentSnippet: result.content.slice(0, 120) });
      return { route: 'simple', confidence: 0.5, subQuestions: [], tokens, parseFailed: true };
    }
  } catch (err: any) {
    logger.error({ type: 'router_agent_error', error: err?.message });
    return { route: 'simple', confidence: 0.5, subQuestions: [], tokens: { input: 0, output: 0 }, parseFailed: true };
  }
}
