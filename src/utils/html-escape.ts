const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapes a string for safe interpolation into raw HTML (server-rendered
 * templates, not JSX - React/JSX already escapes on its own). Used wherever
 * DB-sourced text (approval summaries, department/workflow names) is
 * interpolated into a public-facing page or email body.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char]);
}
