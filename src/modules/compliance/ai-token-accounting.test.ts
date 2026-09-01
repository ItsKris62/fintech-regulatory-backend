import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSrc(relativePath: string): string {
  return readFileSync(resolve(__dirname, '../../..', relativePath), 'utf8');
}

describe('AI token accounting across agents & services', () => {
  it('aggregates multi-agent control tokens (router, grader, verifier, synthesis) in orchestrator', () => {
    const orchestratorCode = readSrc('src/modules/compliance/orchestrator/orchestrator.ts');
    const typesCode = readSrc('src/modules/compliance/orchestrator/types.ts');

    expect(typesCode).toContain('synthesis?: AgentTokens;');
    expect(orchestratorCode).toContain('controlTokens.synthesis = {');
    expect(orchestratorCode).toContain('(controlTokens.synthesis?.input ?? 0)');
    expect(orchestratorCode).toContain('(controlTokens.synthesis?.output ?? 0)');
    expect(orchestratorCode).toContain('tokensUsed: inputTokens + outputTokens');
    expect(orchestratorCode).toContain('tokenBreakdown: {');
  });

  it('preserves measured provider tokens from executeChecklistStream in checklist generation', () => {
    const checklistCode = readSrc('src/modules/compliance/checklist.service.ts');

    expect(checklistCode).toContain('const { checklist, inputTokens, outputTokens } = await this.runTier');
    expect(checklistCode).toContain('{ inputTokens, outputTokens }');
    expect(checklistCode).toContain('inputTokens:             measuredInputTokens');
    expect(checklistCode).toContain('outputTokens:            measuredOutputTokens');
    expect(checklistCode).toContain('tokensUsed:              measuredTotalTokens');
    expect(checklistCode).toContain('estimatedTokens:         !hasMeasuredTokens');
  });

  it('prefers measured provider tokens for trial token tracking in checklist service', () => {
    const checklistCode = readSrc('src/modules/compliance/checklist.service.ts');

    expect(checklistCode).toContain('const tokenCount = hasMeasuredTokens');
    expect(checklistCode).toContain('? measuredTotalTokens');
    expect(checklistCode).toContain("incrementTrialUsage(trialUserId, 'totalTokensUsed', tokenCount)");
  });
});
