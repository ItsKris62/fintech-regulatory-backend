import type { Prisma } from '@prisma/client';
import type { LLMCompletionRequest } from '@/lib/ai/gateway/types';

export const AUTOMATION_AGENT_TYPE = 'automation' as const;

type AutomationUseCase = NonNullable<LLMCompletionRequest['useCase']>;

// The gateway's useCase union drives model selection and timeout bucket; it
// is closed (policy | checklist | query | verification | analysis | default),
// so n8n's free-form taskType is mapped onto it rather than passed through.
const TASK_TYPE_USE_CASE_MAP: Record<string, AutomationUseCase> = {
  regulatory_content_draft: 'analysis',
};

const DEFAULT_USE_CASE: AutomationUseCase = 'analysis';

export function mapTaskTypeToUseCase(taskType: string): AutomationUseCase {
  return TASK_TYPE_USE_CASE_MAP[taskType] ?? DEFAULT_USE_CASE;
}

export function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
