# AI Service (Anthropic Claude)

This directory contains the AI service for SheriaBot using Anthropic's Claude API for policy generation and compliance queries.

## 📁 Structure

```
ai/
├── client.ts                      # Claude API client with streaming and retries
├── ai.service.ts                  # High-level AI service
├── prompts/
│   ├── policy-generation.ts      # Policy framework generation prompts
│   └── compliance-query.ts       # Compliance question prompts
└── README.md                      # This file
```

## 🚀 Getting Started

### 1. Environment Setup

Get an API key from [console.anthropic.com](https://console.anthropic.com) and add to `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

### 2. Test AI Service

```bash
# Run all tests
tsx scripts/test-ai.ts

# Test policy generation only
tsx scripts/test-ai.ts policy

# Test compliance queries only
tsx scripts/test-ai.ts query

# Test quick checks
tsx scripts/test-ai.ts quick
```

## 📚 Usage Examples

### Policy Generation

```typescript
import { aiService } from "@/lib/ai/ai.service";

const result = await aiService.generatePolicy({
  scenario: "A fintech company wants to launch a digital lending app in Kenya",
  organizationType: "FINTECH",
  regulatoryAreas: [
    "Digital Lending",
    "Data Protection",
    "KYC Requirements",
    "Consumer Protection",
  ],
  specificRequirements: "Must comply with CBK Digital Credit Regulations 2022",
  targetAudience: "Internal compliance team",
});

console.log(result.sections.executiveSummary);
console.log("Citations:", result.sections.citations);
console.log("Cost: $", result.cost);
```

### Stream Policy Generation (Real-time)

```typescript
const result = await aiService.streamPolicy(
  {
    scenario: "Mobile payment data protection framework",
    organizationType: "FINTECH",
    regulatoryAreas: ["Data Protection", "Payment Systems"],
  },
  "policy-123", // Policy ID for progress tracking
  (chunk) => {
    // Real-time streaming callback
    console.log(chunk);
    // Send to frontend via SSE
  },
);
```

### Compliance Query

```typescript
const result = await aiService.answerComplianceQuery({
  question:
    "What are the AML requirements for mobile money transfers in Kenya?",
  organizationType: "FINTECH",
  industry: "Mobile Money",
  context: "We process transfers between KSh 100 - KSh 1,000,000",
  urgency: "HIGH",
});

console.log(result.sections.directAnswer);
console.log("Legal basis:", result.sections.legalBasis);
console.log("Requirements:", result.sections.requirements);
console.log("Citations:", result.sections.citations);
```

### Quick Compliance Check

```typescript
const result = await aiService.quickComplianceCheck(
  "We store customer data in AWS us-east-1. Is this compliant with Kenya Data Protection Act?",
);

console.log(result.content);
// Output includes: Compliance status, key issues, immediate actions, legal basis
```

### Follow-up Query

```typescript
const followUp = await aiService.answerFollowUpQuery(
  "What are KYC requirements?", // Original question
  originalAnswer.content, // Original answer
  "What about for high-value transactions?", // Follow-up
);
```

### Citation Verification

```typescript
const verification = await aiService.verifyCitations([
  "Data Protection Act 2019, Section 25(1)",
  "CBK Prudential Guidelines 2013",
  "National Payment Systems Act 2011",
]);

console.log(verification.content);
// Shows which citations are verified, which need checking, which are incorrect
```

### Compare Requirements

```typescript
const comparison = await aiService.compareRequirements(
  "Data Protection Act 2019 data transfer requirements",
  "CBK Guidelines on cross-border payments",
);

console.log(comparison.content);
// Shows similarities, differences, overlap, compliance strategy
```

### Refine Policy

```typescript
const refined = await aiService.refinePolicy(
  originalPolicy.content,
  "Add more detail on consumer complaint handling procedures",
);

console.log(refined.sections.recommendations);
```

## 🔧 Low-Level API

### Basic Completion

```typescript
import { complete } from "@/lib/ai/client";

const result = await complete({
  prompt: "What is the Data Protection Act 2019?",
  systemPrompt: "You are an expert in Kenyan law.",
  maxTokens: 1000,
  temperature: 0.5,
});

console.log(result.content);
console.log("Cost: $", result.cost);
console.log("Tokens:", result.inputTokens, "+", result.outputTokens);
```

### Streaming Completion

```typescript
import { stream } from "@/lib/ai/client";

const result = await stream({
  prompt: "Explain Kenya's data protection principles",
  systemPrompt: "You are a legal expert.",
  maxTokens: 2000,
  onChunk: (chunk) => {
    process.stdout.write(chunk);
  },
  onComplete: (result) => {
    console.log("\nCost:", result.cost);
  },
  onError: (error) => {
    console.error("Error:", error);
  },
});
```

### With Caching

```typescript
// Cache response for 1 hour (3600 seconds)
const result = await complete(
  {
    prompt: "What is the KRA PIN format?",
    maxTokens: 200,
  },
  "query",
  3600, // Cache TTL
);

// Second call will use cached result (result.cached = true)
const cached = await complete(
  {
    prompt: "What is the KRA PIN format?",
    maxTokens: 200,
  },
  "query",
  3600,
);

console.log("Cached:", cached.cached); // true
```

## 💰 Cost Management

### Check Today's Cost

```typescript
import { getTodayAICost, getAIStats } from "@/lib/ai/client";

const todayCost = await getTodayAICost();
console.log("Today:", todayCost);

const stats = await getAIStats();
console.log({
  todayCost: stats.todayCost,
  dailyLimit: stats.dailyLimit,
  remaining: stats.remainingBudget,
  percentUsed: stats.percentUsed,
});
```

### Cost Tracking

All AI requests automatically track costs in Redis:

- Daily costs stored for 7 days
- Cost limit enforced ($500/day by default)
- Costs calculated per model and token usage

### Model Selection

Models are automatically selected based on use case:

```typescript
// Policy generation: claude-3-sonnet (balanced quality/speed)
await aiService.generatePolicy(...);

// Compliance queries: claude-3-haiku (fast, cost-effective)
await aiService.answerComplianceQuery(...);

// Citation verification: claude-3-haiku (simple task)
await aiService.verifyCitations(...);
```

Or specify manually:

```typescript
await complete({
  prompt: "Your prompt",
  model: "claude-3-opus-20240229", // Highest quality
});
```

## 📊 Response Caching

Responses are automatically cached to reduce costs:

- **Policy generation**: 1 hour
- **Compliance queries**: 24 hours
- **Citation verification**: 7 days

Cached responses are free (no API cost).

## 🎯 Prompt Engineering

### Policy Generation Prompts

The policy generation system prompt instructs Claude to:

- Act as Kenyan regulatory compliance expert
- Provide specific legal citations
- Use professional regulatory language
- Structure responses with clear sections
- Consider practical Kenyan context

### Compliance Query Prompts

The compliance query system prompt ensures:

- Direct, actionable answers
- Specific legal citations
- Implementation guidance
- Timeline information
- Non-compliance consequences

### Custom Prompts

You can create custom prompts for specific use cases:

```typescript
import { complete } from "@/lib/ai/client";

const systemPrompt = `You are an expert in [specific area].
Follow these rules:
1. Always cite specific laws
2. Use professional language
3. Provide actionable advice`;

const userPrompt = `[Your specific question or task]`;

const result = await complete({
  prompt: userPrompt,
  systemPrompt,
  maxTokens: 2000,
});
```

## 🔄 Real-Time Progress Tracking

### Policy Generation with Progress

```typescript
import { policyProgressPubSub } from "@/lib/redis/pubsub";

// Subscribe to progress updates
const unsubscribe = await policyProgressPubSub.subscribe(
  "policy-123",
  (event) => {
    console.log(`Progress: ${event.progress}% - ${event.message}`);
    // Send to frontend via SSE
  },
);

// Generate policy (automatically publishes progress)
await aiService.streamPolicy(params, "policy-123", onChunk);

// Clean up
await unsubscribe();
```

Progress events:

- `generation_started` (0%)
- `analyzing_regulations` (25%)
- `generating_recommendations` (50%)
- `creating_checklist` (75%)
- `generation_complete` (100%)
- `generation_failed` (error)

## 🛡️ Error Handling

### Automatic Retries

The client automatically retries on:

- 408 (Request Timeout)
- 429 (Rate Limit)
- 500 (Server Error)
- 502 (Bad Gateway)
- 503 (Service Unavailable)
- 504 (Gateway Timeout)

Retry strategy:

- Max 3 attempts
- Exponential backoff (1s, 2s, 4s)

### Error Handling Example

```typescript
import { AIServiceError } from "@/utils/error";

try {
  const result = await aiService.generatePolicy(params);
} catch (error) {
  if (error instanceof AIServiceError) {
    console.error("AI service error:", error.message);
    // Handle AI-specific errors
  } else {
    console.error("Unexpected error:", error);
  }
}
```

## 📝 Response Parsing

### Extract Policy Sections

```typescript
import { extractPolicySections } from "@/lib/ai/prompts/policy-generation";

const sections = extractPolicySections(response.content);

console.log(sections.executiveSummary);
console.log(sections.regulatoryLandscape);
console.log(sections.recommendations);
console.log(sections.complianceChecklist);
console.log(sections.riskAssessment);
console.log(sections.implementationRoadmap);
console.log(sections.citations);
```

### Extract Answer Sections

```typescript
import { extractAnswerSections } from "@/lib/ai/prompts/compliance-query";

const sections = extractAnswerSections(response.content);

console.log(sections.directAnswer);
console.log(sections.legalBasis);
console.log(sections.requirements);
console.log(sections.guidance);
console.log(sections.timeline);
console.log(sections.consequences);
console.log(sections.relatedConsiderations);
console.log(sections.citations);
```

## 🚨 Best Practices

1. **Always use caching** for repeated queries
2. **Monitor daily costs** - set up alerts
3. **Choose appropriate models** - Haiku for simple tasks, Sonnet for complex
4. **Verify citations** - AI may hallucinate legal references
5. **Stream long responses** - better UX for policy generation
6. **Track progress** - use pub/sub for real-time updates
7. **Handle errors gracefully** - retries are automatic but not infinite
8. **Cache aggressively** - policy content rarely changes
9. **Test prompts** - iterate on prompt engineering for better results
10. **Review AI output** - Always have human review for legal content

## ⚙️ Configuration

All AI configuration is in `src/config/ai.config.ts`:

```typescript
export const aiConfig = {
  models: {
    policy: {
      model: "claude-3-sonnet-20240229",
      temperature: 0.3,
      maxTokens: 8000,
    },
    complianceQuery: {
      model: "claude-3-haiku-20240307",
      temperature: 0.5,
      maxTokens: 4000,
    },
    citationVerification: {
      model: "claude-3-haiku-20240307",
      temperature: 0.3,
      maxTokens: 2000,
    },
  },
  cost: {
    dailyLimit: 500, // $500/day
  },
  cache: {
    ttl: {
      policy: 3600, // 1 hour
      complianceQuery: 86400, // 24 hours
      citationVerification: 604800, // 7 days
    },
  },
};
```

## 📚 Additional Resources

- [Anthropic Documentation](https://docs.anthropic.com)
- [Claude API Reference](https://docs.anthropic.com/claude/reference)
- [Prompt Engineering Guide](https://docs.anthropic.com/claude/docs/prompt-engineering)
- [Model Comparison](https://docs.anthropic.com/claude/docs/models-overview)
