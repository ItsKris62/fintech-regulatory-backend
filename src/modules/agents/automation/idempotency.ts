import { createHash } from 'node:crypto';

export interface GenerateIdempotencyInput {
  workflowKey: string;
  taskType: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
}

const NUL = String.fromCharCode(0);

/**
 * Deterministic idempotency key for agents.automation.generate.
 *
 * A byte-identical retried request (n8n webhook retry, manual re-run) must
 * hash to the same key so agentRunService.beginRun() dedupes it against the
 * original AgentRun instead of starting a new LLM call. NUL-separated so a
 * field boundary can never be forged by content inside a neighbouring field
 * (e.g. workflowKey "a" + taskType "bc" cannot collide with workflowKey "ab"
 * + taskType "c" the way plain concatenation could).
 */
export function deriveGenerateIdempotencyKey(input: GenerateIdempotencyInput): string {
  const payload = [
    input.workflowKey,
    input.taskType,
    input.systemPrompt,
    input.userPrompt,
    String(input.maxTokens),
  ].join(NUL);

  return createHash('sha256').update(payload).digest('hex');
}
