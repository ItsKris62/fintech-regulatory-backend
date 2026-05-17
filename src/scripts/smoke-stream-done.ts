/**
 * Smoke test: POST /api/compliance/stream
 * Verifies the `done` SSE event includes citations + confidence with correct shapes.
 *
 * Usage:
 *   SMOKE_EMAIL=you@example.com SMOKE_PASS=yourpass \
 *   npx ts-node -r tsconfig-paths/register src/scripts/smoke-stream-done.ts
 */
import { createClient } from '@supabase/supabase-js';
import { appConfig } from '@/config/app.config';

const BACKEND_BASE = `http://localhost:${process.env.PORT ?? 4000}`;

async function main() {
  const email = process.env.SMOKE_EMAIL;
  const pass  = process.env.SMOKE_PASS;

  if (!email || !pass) {
    console.error('SMOKE_EMAIL and SMOKE_PASS env vars are required');
    process.exit(1);
  }

  // ── 1. Get JWT via Supabase sign-in ────────────────────────────────────────
  const supabase = createClient(appConfig.supabase.url, appConfig.supabase.anonKey);
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password: pass });
  if (authError || !authData.session) {
    console.error('Auth failed:', authError?.message);
    process.exit(1);
  }
  const token = authData.session.access_token;
  console.log('✓ Authenticated');

  // ── 2. Open SSE stream ──────────────────────────────────────────────────────
  const res = await fetch(`${BACKEND_BASE}/api/compliance/stream`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body:    JSON.stringify({ question: 'What are the CBK capital adequacy requirements for Tier 1 banks in Kenya?' }),
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    console.error(`HTTP ${res.status}:`, body);
    process.exit(1);
  }

  console.log('✓ Stream opened');

  // ── 3. Parse SSE events until `done` ───────────────────────────────────────
  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer    = '';
  let doneEvent: Record<string, unknown> | null = null;

  try {
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const line = part.trim();
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data: '))   continue;

        const event = JSON.parse(line.slice('data: '.length)) as { type: string };
        process.stdout.write(`  [${event.type}]\r`);

        if (event.type === 'done') {
          doneEvent = event as Record<string, unknown>;
          break outer;
        }
        if (event.type === 'error') {
          console.error('\n✗ SSE error event:', (event as any).message);
          process.exit(1);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!doneEvent) {
    console.error('\n✗ Stream ended without a done event');
    process.exit(1);
  }

  // ── 4. Print the verification payload ─────────────────────────────────────
  const { citations, confidence, route, grounded, abstained, runId } = doneEvent as any;

  console.log('\n\n══ done event payload ══════════════════════════════════════');
  console.log(JSON.stringify({
    route,
    grounded,
    abstained,
    runId,
    confidence,
    citations_count: Array.isArray(citations) ? citations.length : 'NOT_ARRAY',
    citations_shape: Array.isArray(citations) && citations.length > 0
      ? citations.slice(0, 2).map((c: any) => ({
          documentId:    c.documentId,
          documentTitle: c.documentTitle,
          section:       c.section,
          textSnippet:   c.textSnippet?.slice(0, 80) + (c.textSnippet?.length > 80 ? '...' : ''),
          score:         c.score,
          citation:      c.citation,
        }))
      : [],
  }, null, 2));

  // ── 5. Assertions ──────────────────────────────────────────────────────────
  let pass_count = 0;
  let fail_count = 0;

  function assert(label: string, cond: boolean) {
    if (cond) { console.log(`  ✓ ${label}`); pass_count++; }
    else       { console.error(`  ✗ ${label}`); fail_count++; }
  }

  console.log('\n══ assertions ══════════════════════════════════════════════');
  assert('citations is array',       Array.isArray(citations));
  assert('confidence is number|null', confidence === null || typeof confidence === 'number');
  if (Array.isArray(citations) && citations.length > 0) {
    const c = citations[0];
    assert('citation[0].documentTitle is string',  typeof c.documentTitle === 'string');
    assert('citation[0].section is string',        typeof c.section === 'string');
    assert('citation[0].textSnippet is string',    typeof c.textSnippet === 'string');
    assert('citation[0].score is number',          typeof c.score === 'number');
    assert('citation[0].citation is string|null',  c.citation === null || typeof c.citation === 'string');
  }

  console.log(`\n${fail_count === 0 ? '✓ SMOKE_OK' : '✗ SMOKE_FAIL'} — ${pass_count} passed, ${fail_count} failed`);
  process.exit(fail_count > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
