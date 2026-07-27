import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  agentCredentialService,
  AGENT_CREDENTIAL_HEADER,
} from '@/modules/agents/agent-credential.service';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import {
  AutomationIncidentSeverity,
  SideEffectState,
  AutomationIncidentStatus,
} from '@prisma/client';
import crypto from 'node:crypto';
import * as Sentry from '@sentry/node';
import { sanitizePayload } from '@/utils/sanitizer';

const INCIDENT_COOLDOWN_SECONDS = 3600;

const createIncidentSchema = z.object({
  fingerprint: z.string().length(64).regex(/^[a-f0-9]+$/i),
  environment: z.string().min(1).max(50),
  workflowKey: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  severity: z.nativeEnum(AutomationIncidentSeverity),
  retryable: z.boolean(),
  requiresHumanAction: z.boolean(),
  sideEffectState: z.nativeEnum(SideEffectState),
  safeMessage: z.string().max(2000),
  executionId: z.string().max(200).optional(),
  nodeName: z.string().max(300).optional(),
  nodeType: z.string().max(200).optional(),
  httpStatus: z.number().int().optional(),
  errorCode: z.string().max(100).optional(),
  attempt: z.number().int().default(1),
  maxAttempts: z.number().int().optional(),
  correlationId: z.string().max(200).optional(),
  sentryTraceId: z.string().max(200).optional(),
  sentryEventId: z.string().max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  occurredAt: z.string().datetime().optional(),
  owner: z.string().max(100).default('platform-ops'),
  department: z.string().max(100).default('engineering'),
  runbookUrl: z.string().url().max(500).optional(),
});

type CreateIncidentBody = z.infer<typeof createIncidentSchema>;

export const registerAutomationIncidentRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post<{ Body: CreateIncidentBody }>(
    '/internal/automation/v1/incidents',
    async (request, reply) => {
      // 1. Authentication
      const credential = request.headers[AGENT_CREDENTIAL_HEADER] || request.headers[AGENT_CREDENTIAL_HEADER.toLowerCase()];
      const credentialValue = Array.isArray(credential) ? credential[0] : credential;

      if (!credentialValue) {
        return reply.status(401).send({ error: 'Missing agent credential' });
      }

      try {
        const identity = await agentCredentialService.verifyCredential(credentialValue);
        if (!identity.capabilities.includes('agents.automation.incident.create')) {
          return reply.status(403).send({ error: 'Missing required capability' });
        }
      } catch (err) {
        logger.warn({ type: 'automation_incident_auth_failed', error: err instanceof Error ? err.message : String(err) });
        return reply.status(401).send({ error: 'Invalid agent credential' });
      }

      // 2. Header Extraction & Validation
      const extractHeader = (name: string) => {
        const val = request.headers[name] || request.headers[name.toLowerCase()];
        return Array.isArray(val) ? val[0] : val;
      };

      const idempotencyKey = extractHeader('idempotency-key');
      const xCorrelationId = extractHeader('x-correlation-id');
      const xWorkflowKey = extractHeader('x-workflow-key');
      const xExecutionId = extractHeader('x-n8n-execution-id');

      if (!idempotencyKey || !/^[a-f0-9]{64}$/i.test(idempotencyKey)) {
        return reply.status(400).send({ error: 'Missing or invalid Idempotency-Key header. Must be 64-char hex string.' });
      }
      if (idempotencyKey === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' || idempotencyKey === 'd41d8cd98f00b204e9800998ecf8427e') {
        return reply.status(400).send({ error: 'Idempotency-Key is an empty-input hash.' });
      }

      // 3. Body Validation
      const parseResult = createIncidentSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: 'Invalid request body', details: parseResult.error.flatten() });
      }

      const rawData = parseResult.data;

      if (rawData.fingerprint === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' || rawData.fingerprint === 'd41d8cd98f00b204e9800998ecf8427e') {
        return reply.status(400).send({ error: 'Fingerprint is an empty-input hash.' });
      }
      if (idempotencyKey.toLowerCase() === rawData.fingerprint.toLowerCase()) {
        return reply.status(400).send({ error: 'Idempotency-Key cannot equal Fingerprint' });
      }
      if (xWorkflowKey && xWorkflowKey !== rawData.workflowKey) {
        return reply.status(400).send({ error: 'X-Workflow-Key header does not match body' });
      }
      if (xExecutionId && rawData.executionId && xExecutionId !== rawData.executionId) {
        return reply.status(400).send({ error: 'X-n8n-Execution-ID header does not match body' });
      }

      // Secondary backend sanitization
      const safeMessage = sanitizePayload(rawData.safeMessage) as string;
      const metadata = sanitizePayload(rawData.metadata) as Record<string, unknown>;

      const data = { ...rawData, safeMessage, metadata };
      const occurredAt = data.occurredAt ? new Date(data.occurredAt) : new Date();

      const reqLogger = logger.child({
        correlationId: xCorrelationId || data.correlationId,
        workflowKey: data.workflowKey,
        executionId: data.executionId,
      });

      return Sentry.withIsolationScope(async (scope) => {
        scope.setTag('correlation_id', xCorrelationId || data.correlationId || 'unknown');
        scope.setTag('workflow_key', data.workflowKey || 'unknown');
        scope.setTag('execution_id', data.executionId || 'unknown');
        scope.setTag('idempotency_key_prefix', idempotencyKey.substring(0, 12));

        let notify = false;
        let notificationHandled = false;
        let incidentId: string;
        let occurrenceId: string;
        let isNewIncident = false;
        let finalOccurrenceCount = 1;
        let finalStatus: AutomationIncidentStatus = AutomationIncidentStatus.OPEN;
        
        try {
          // 4. Early Idempotency Check (Advisory)
          const existingOccurrence = await prisma.automationIncidentOccurrence.findUnique({
            where: { idempotencyKey },
            include: { incident: true }
          });
          
          if (existingOccurrence) {
            return reply.status(200).send({
              persisted: true,
              incidentId: existingOccurrence.incidentId,
              occurrenceId: existingOccurrence.id,
              isNewIncident: false,
              occurrenceCount: existingOccurrence.incident.occurrenceCount,
              severity: existingOccurrence.incident.severity,
              notify: false,
              notificationHandled: true,
              status: existingOccurrence.incident.status,
            });
          }

          const incidentHash = crypto.createHash('sha256').update(data.fingerprint).digest('hex');
          const cacheKey = `sheriabot:incidents:state:${data.environment}:${incidentHash}`;
          
          let cachedState: any = null;
          try {
            const rawCached = await redis.get(cacheKey);
            if (rawCached) cachedState = typeof rawCached === 'string' ? JSON.parse(rawCached) : rawCached;
          } catch (redisErr) {
            reqLogger.warn({ type: 'redis_fetch_error', error: String(redisErr) });
          }

          // 5. Database transaction (safe composite upsert pattern)
          const result = await prisma.$transaction(async (tx) => {
            const upsertData = {
              fingerprint: data.fingerprint,
              environment: data.environment,
              workflowKey: data.workflowKey,
              category: data.category,
              severity: data.severity,
              status: AutomationIncidentStatus.OPEN,
              firstSeenAt: occurredAt,
              lastSeenAt: occurredAt,
              retryable: data.retryable,
              requiresHumanAction: data.requiresHumanAction,
              sideEffectState: data.sideEffectState,
              safeMessage: data.safeMessage,
              latestExecutionId: data.executionId,
              latestNodeName: data.nodeName,
              correlationId: data.correlationId,
              sentryEventId: data.sentryEventId,
              owner: data.owner,
              department: data.department,
              runbookUrl: data.runbookUrl,
              metadata: data.metadata ?? {},
            };

            const incident = await tx.automationIncident.upsert({
              where: { environment_fingerprint: { environment: data.environment, fingerprint: data.fingerprint } },
              create: { ...upsertData, occurrenceCount: 0 },
              update: {
                ...upsertData,
                severity: data.severity === 'CRITICAL' ? 'CRITICAL' : undefined, // only escalate
                status: undefined, // Handle reopen explicitly later
                firstSeenAt: undefined, // Never update
                occurrenceCount: undefined // Handled separately
              }
            });

            isNewIncident = incident.occurrenceCount === 0;

            if (!isNewIncident && incident.status === AutomationIncidentStatus.RESOLVED) {
              await tx.automationIncident.update({
                where: { id: incident.id },
                data: { status: AutomationIncidentStatus.OPEN }
              });
              incident.status = AutomationIncidentStatus.OPEN;
            }

            finalStatus = incident.status;

            // Insert Occurrence
            const occurrence = await tx.automationIncidentOccurrence.create({
              data: {
                incidentId: incident.id,
                idempotencyKey,
                executionId: data.executionId,
                workflowId: data.workflowKey,
                nodeName: data.nodeName,
                nodeType: data.nodeType,
                httpStatus: data.httpStatus,
                errorCode: data.errorCode,
                attempt: data.attempt,
                maxAttempts: data.maxAttempts,
                correlationId: data.correlationId,
                sentryTraceId: data.sentryTraceId,
                sentryEventId: data.sentryEventId,
                safeMessage: data.safeMessage,
                metadata: data.metadata ?? {},
                occurredAt,
              },
            });

            // Increment Count
            const updatedIncident = await tx.automationIncident.update({
              where: { id: incident.id },
              data: { occurrenceCount: { increment: 1 } },
            });

            finalOccurrenceCount = updatedIncident.occurrenceCount;
            return { incident: updatedIncident, occurrence };
          });

          incidentId = result.incident.id;
          occurrenceId = result.occurrence.id;

          // Notification decision logic
          if (isNewIncident) {
            notify = true;
          } else {
            const timeSinceLastNotified = cachedState?.lastNotifiedAt 
              ? occurredAt.getTime() - new Date(cachedState.lastNotifiedAt).getTime()
              : INCIDENT_COOLDOWN_SECONDS * 1000 + 1;

            const isSeverityEscalated = data.severity === 'CRITICAL' && cachedState?.lastNotifiedSeverity !== 'CRITICAL';
            
            if (timeSinceLastNotified > INCIDENT_COOLDOWN_SECONDS * 1000 || isSeverityEscalated || cachedState?.status === 'RESOLVED') {
              notify = true;
            }
          }

          try {
            await redis.set(cacheKey, JSON.stringify({
              lastNotifiedAt: notify ? occurredAt.toISOString() : (cachedState?.lastNotifiedAt || occurredAt.toISOString()),
              lastNotifiedSeverity: notify ? data.severity : (cachedState?.lastNotifiedSeverity || data.severity),
              lastNotifiedOccurrenceCount: finalOccurrenceCount,
              status: finalStatus,
            }), { ex: INCIDENT_COOLDOWN_SECONDS * 24 });
          } catch (redisErr) {
            reqLogger.warn({ type: 'redis_save_error', error: String(redisErr) });
          }

          if (notify) {
            reqLogger.error({
              type: 'automation_incident_alert',
              incidentId,
              fingerprint: data.fingerprint,
              workflow: data.workflowKey,
              severity: data.severity,
              message: data.safeMessage,
            });
            notificationHandled = false; 
          } else {
            reqLogger.info({
              type: 'automation_incident_suppressed',
              incidentId,
              fingerprint: data.fingerprint,
              workflow: data.workflowKey,
            });
            notificationHandled = true;
          }

          return reply.status(200).send({
            persisted: true,
            incidentId,
            occurrenceId,
            isNewIncident,
            occurrenceCount: finalOccurrenceCount,
            severity: data.severity,
            notify,
            notificationHandled,
            status: finalStatus,
          });

        } catch (error: any) {
          // If the occurrence insert threw P2002, the transaction rolls back. 
          // We catch it here outside the transaction block.
          if (error?.code === 'P2002' && error?.meta?.target?.includes('idempotencyKey')) {
            reqLogger.info({ type: 'automation_incident_idempotent_hit_concurrent', idempotencyKey });
            
            // Re-fetch existing
            const existingOccurrence = await prisma.automationIncidentOccurrence.findUnique({
              where: { idempotencyKey },
              include: { incident: true }
            });
            
            if (existingOccurrence) {
              return reply.status(200).send({
                persisted: true,
                incidentId: existingOccurrence.incidentId,
                occurrenceId: existingOccurrence.id,
                isNewIncident: false, // by definition
                occurrenceCount: existingOccurrence.incident.occurrenceCount,
                severity: existingOccurrence.incident.severity,
                notify: false,
                notificationHandled: true,
                status: existingOccurrence.incident.status,
              });
            }
          }

          reqLogger.error({
            type: 'automation_incident_db_error',
            error: error instanceof Error ? error.message : String(error),
          });
          
          return reply.status(500).send({ 
            error: 'Internal Server Error',
            persisted: false, 
          });
        }
      });
    },
  );

  app.post<{ Params: { id: string }, Body: { note?: string } }>(
    '/internal/automation/v1/incidents/:id/resolve',
    async (request, reply) => {
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const token = authHeader.substring(7);
      let adminUserId: string | null = null;
      try {
        const { supabaseAdmin } = await import('@/lib/supabase');
        const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
        if (authError || !authData?.user?.id) {
          return reply.status(401).send({ error: 'Unauthorized' });
        }

        const dbUser = await prisma.user.findUnique({
          where: { supabaseAuthId: authData.user.id },
          select: { id: true, role: true, deletedAt: true, accountStatus: true },
        });

        if (!dbUser || dbUser.role !== 'ADMIN' || dbUser.deletedAt !== null) {
          return reply.status(403).send({ error: 'Forbidden' });
        }
        if (dbUser.accountStatus === 'suspended' || dbUser.accountStatus === 'rejected') {
          return reply.status(403).send({ error: 'Forbidden: Account suspended' });
        }

        adminUserId = dbUser.id;
      } catch (err: unknown) {
        logger.warn({
          type: 'incident_resolve_auth_error',
          error: err instanceof Error ? err.message : String(err),
          ip: request.ip,
        });
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      try {
        const note = sanitizePayload(request.body?.note || '') as string;
        
        const incident = await prisma.$transaction(async (tx) => {
          const updated = await tx.automationIncident.update({
            where: { id: request.params.id },
            data: { status: AutomationIncidentStatus.RESOLVED },
          });

          await tx.auditLog.create({
            data: {
              userId: adminUserId!,
              action: 'RESOLVE_AUTOMATION_INCIDENT',
              entityType: 'AutomationIncident',
              entityId: updated.id,
              metadata: { note: note.substring(0, 500) },
              ipAddress: request.ip,
            }
          });

          return updated;
        });

        return reply.status(200).send({ success: true, incidentId: incident.id });
      } catch (error: unknown) {
        return reply.status(404).send({ error: 'Incident not found' });
      }
    },
  );
};
