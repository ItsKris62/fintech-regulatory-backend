/**
 * Checklist Generation Progress — Server-Sent Events Route
 *
 * GET /api/checklist/:id/progress
 *
 * Streams live progress events for an in-flight checklist generation.
 * Auth: Bearer token (same Supabase JWT used by tRPC).
 *
 * Event format (newline-delimited SSE):
 *   data: {"type":"started","message":"Connecting to AI..."}
 *   data: {"type":"progress","message":"Building section 2...","categoriesDetected":2}
 *   data: {"type":"parsing","message":"Validating checklist structure..."}
 *   data: {"type":"complete","message":"Checklist generated successfully","itemCount":45}
 *   data: {"type":"error","message":"..."}
 *
 * The connection closes automatically on "complete" or "error".
 * If the checklist is already in a terminal state when the client connects,
 * a single synthetic event is sent and the connection closes immediately.
 *
 * This endpoint is purely additive — the existing tRPC polling flow is
 * unaffected and remains the authoritative source for checklist status.
 */

import type { FastifyInstance } from 'fastify';
import { supabaseAdmin } from '@/lib/supabase';
import { prisma } from '@/lib/prisma/client';
import { checklistProgressPubSub } from '@/lib/redis/pubsub';
import { logger } from '@/utils/logger';

/** Max duration before the SSE connection is forcibly closed (5 minutes). */
const SSE_MAX_DURATION_MS = 5 * 60 * 1_000;

/** Keep-alive comment interval to prevent proxy/load-balancer timeouts. */
const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

export async function registerChecklistProgressRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/api/checklist/:id/progress',
    async (request, reply) => {
      const { id: checklistId } = request.params;

      // ── 1. Auth ─────────────────────────────────────────────────────────
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return reply.status(401).send({ error: 'Missing or invalid Authorization header' });
      }
      const token = authHeader.substring(7);

      let supabaseUserId: string;
      try {
        const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
        if (authError || !authData?.user?.id) {
          return reply.status(401).send({ error: 'Invalid token' });
        }
        supabaseUserId = authData.user.id;
      } catch {
        return reply.status(401).send({ error: 'Token verification failed' });
      }

      const dbUser = await prisma.user.findUnique({
        where:  { supabaseAuthId: supabaseUserId },
        select: { id: true, organizationId: true },
      });
      if (!dbUser) {
        return reply.status(401).send({ error: 'User not found' });
      }

      // ── 2. Ownership check ───────────────────────────────────────────────
      const checklist = await prisma.checklist.findUnique({
        where:  { id: checklistId },
        select: { id: true, organizationId: true, userId: true, status: true, deletedAt: true },
      });

      if (!checklist || checklist.deletedAt !== null) {
        return reply.status(404).send({ error: 'Checklist not found' });
      }

      const hasAccess =
        (checklist.organizationId !== null && checklist.organizationId === dbUser.organizationId) ||
        checklist.userId === dbUser.id;

      if (!hasAccess) {
        return reply.status(403).send({ error: 'You do not have access to this checklist' });
      }

      // ── 3. SSE headers ───────────────────────────────────────────────────
      reply.raw.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
        'X-Accel-Buffering': 'no', // disable Nginx response buffering
      });

      // ── 4. If checklist is already terminal, send final event and close ──
      const terminalStatus = checklist.status;
      if (terminalStatus === 'IN_PROGRESS' || terminalStatus === 'COMPLETED') {
        reply.raw.write(
          `data: ${JSON.stringify({ type: 'complete', message: 'Checklist already generated' })}\n\n`
        );
        reply.raw.end();
        return;
      }
      if (terminalStatus === 'FAILED') {
        reply.raw.write(
          `data: ${JSON.stringify({ type: 'error', message: 'Checklist generation failed' })}\n\n`
        );
        reply.raw.end();
        return;
      }

      // ── 5. Live SSE subscription ─────────────────────────────────────────
      logger.info({ type: 'checklist_sse_connected', checklistId, userId: dbUser.id });

      let unsubscribe: (() => void) | null = null;
      let closed = false;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAliveId);
        clearTimeout(maxDurationId);
        if (unsubscribe) unsubscribe();
        logger.info({ type: 'checklist_sse_disconnected', checklistId, userId: dbUser.id });
      };

      // Keep-alive: SSE comment lines are invisible to event listeners
      const keepAliveId = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(': ping\n\n');
      }, SSE_KEEPALIVE_INTERVAL_MS);

      // Hard cap: close connection after SSE_MAX_DURATION_MS regardless
      const maxDurationId = setTimeout(() => {
        if (!reply.raw.destroyed) {
          reply.raw.write(
            `data: ${JSON.stringify({ type: 'error', message: 'Generation timed out — check status via polling' })}\n\n`
          );
          reply.raw.end();
        }
        cleanup();
      }, SSE_MAX_DURATION_MS);

      // Clean up when the client disconnects
      request.raw.on('close', cleanup);

      unsubscribe = await checklistProgressPubSub.subscribe(checklistId, (event) => {
        if (closed || reply.raw.destroyed) {
          cleanup();
          return;
        }

        reply.raw.write(
          `data: ${JSON.stringify({
            type:               event.type,
            message:            event.message,
            categoriesDetected: event.categoriesDetected,
            itemCount:          event.itemCount,
          })}\n\n`
        );

        if (event.type === 'complete' || event.type === 'error') {
          reply.raw.end();
          cleanup();
        }
      });
    }
  );
}
