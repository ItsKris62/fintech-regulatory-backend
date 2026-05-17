export type OrchestratorRoute = 'simple' | 'complex' | 'abstain';

export interface AgentTokens {
  input: number;
  output: number;
}

export interface ControlTokens {
  router?: AgentTokens;
  grader?: AgentTokens;
  verifier?: AgentTokens;
}

export interface TokenBudget {
  maxTotalTokens: number;
  maxRetrievalQueries: number;
  maxGradeChunks: number;
}

export const TOKEN_BUDGETS: Record<'simple' | 'complex', TokenBudget> = {
  simple:  { maxTotalTokens: 50_000,  maxRetrievalQueries: 4, maxGradeChunks: 20 },
  complex: { maxTotalTokens: 150_000, maxRetrievalQueries: 4, maxGradeChunks: 20 },
};

export interface AcceptedChunkRef {
  documentId: string;
  documentTitle: string;
  section?: string;
  rank: number;
}

export interface QueryRunTrace {
  complianceQueryId:    string;
  shadow:               boolean;
  status:               string;
  route:                OrchestratorRoute;
  routeConfidence:      number | null;
  routeDowngraded:      boolean;
  routeDowngradeReason: string | null;
  grounded:             boolean;
  ragSources:           number;
  subQuestions:         string[];
  retrievalQueries:     string[];
  gradeChunksInspected: number;
  acceptedChunkIds:     AcceptedChunkRef[];
  rejectedChunkCount:   number;
  tokenBudgetExceeded:  boolean;
  controlTokens:        ControlTokens;
  inputTokens:          number;
  outputTokens:         number;
  graderFailed:         boolean;
  routerParseFallback:  boolean;
  verifierParseFallback: boolean;
  verifierVerdict:      string | null;
  unsupportedClaims:    string[];
  fallbackReason:       string | null;
  errorMessage:         string | null;
  wallMs:               number;
}
