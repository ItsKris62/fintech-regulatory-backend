import { complete } from '@/lib/ai/client';

async function main() {
  const SYSTEM = `You are a query router. Respond with a single JSON object: {"route":"simple","confidence":0.9,"reason":"test","subQuestions":[]}. No other text.`;
  const result = await complete(
    { prompt: 'What is the minimum capital for a microfinance bank?', systemPrompt: SYSTEM, maxTokens: 200, temperature: 0.0 },
    'query'
  );
  console.log('RAW CONTENT:');
  console.log(JSON.stringify(result.content));
}
main().catch(console.error);
