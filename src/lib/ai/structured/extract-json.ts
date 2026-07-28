// Maximum raw response length this layer will even attempt to parse — a
// defense-in-depth cap, not a normal-path limit. Pack 1's largest expected use
// case (research-pack synthesis) targets low thousands of output tokens.
export const MAX_STRUCTURED_RESPONSE_LENGTH = 200_000;

const FENCED_BLOCK_PATTERN = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

/**
 * Extracts a JSON object candidate from raw model output text. Handles:
 *  - a fenced code block (```json ... ``` or ``` ... ```) wrapping the whole response
 *  - unfenced raw JSON
 *  - prose-wrapped JSON ("Here is the JSON: { ... } Let me know if...")
 * Returns null if no '{'/'}' pair can be found at all. Never uses eval/Function —
 * only string slicing, matching the actual parse attempt to JSON.parse.
 */
export function extractJsonCandidate(rawText: string): string | null {
  const trimmed = rawText.trim();
  const fenceMatch = trimmed.match(FENCED_BLOCK_PATTERN);
  const unfenced = fenceMatch ? fenceMatch[1].trim() : trimmed;

  if (unfenced.startsWith('{') && unfenced.endsWith('}')) {
    return unfenced;
  }

  const firstBrace = unfenced.indexOf('{');
  const lastBrace = unfenced.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  return unfenced.slice(firstBrace, lastBrace + 1);
}
