/**
 * Extracts a JSON string from a model response that may be wrapped in markdown
 * code fences (e.g. ```json ... ```). Falls back to the raw trimmed content so
 * callers can attempt JSON.parse and handle errors uniformly.
 */
export function extractJson(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return fenced ? fenced[1].trim() : trimmed;
}
