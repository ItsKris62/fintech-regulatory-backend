import { Prisma } from '@prisma/client';

export const LEGACY_GAP_ANALYSIS_DOCUMENT_FIELDS = [
  'fileContent',
  'base64',
  'fileBuffer',
  'rawText',
] as const;

export const ACTIVE_GAP_ANALYSIS_JOB_STATUSES = ['QUEUED', 'RUNNING', 'RETRYING'] as const;
export const TERMINAL_GAP_ANALYSIS_JOB_STATUSES = [
  'COMPLETED',
  'FAILED',
  'DEAD_LETTERED',
  'CANCELLED',
] as const;

type CleanupClient = {
  aiJob: {
    findMany: (args: any) => Promise<unknown[]>;
  };
  auditLog: {
    create: (args: any) => Promise<unknown>;
  };
  $transaction: (callback: (tx: { aiJob: { update: (args: any) => Promise<unknown> } }) => Promise<void>) => Promise<unknown>;
};

type CleanupRow = {
  id: string;
  status: string;
  payload: Prisma.JsonValue;
};

export type GapAnalysisPayloadCleanupSummary = {
  dryRun: boolean;
  rowsInspected: number;
  legacyPayloadsDetected: number;
  terminalAndSafeToScrub: number;
  activeOrRetryable: number;
  activeWithSupportedFileContentFallback: number;
  activeWithUnsupportedLegacyShape: number;
  unknownStatus: number;
  alreadyClean: number;
  rowsScrubbed: number;
  documentsPrinted: 0;
  statusCounts: Record<string, number>;
  fieldCounts: Record<(typeof LEGACY_GAP_ANALYSIS_DOCUMENT_FIELDS)[number], number>;
};

function isJsonObject(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function legacyDocumentFields(payload: Prisma.JsonValue): string[] {
  if (!isJsonObject(payload)) return [];
  return LEGACY_GAP_ANALYSIS_DOCUMENT_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(payload, field),
  );
}

export function scrubLegacyDocumentFields(
  payload: Prisma.JsonValue,
  scrubbedAt: string,
): Prisma.InputJsonValue {
  if (!isJsonObject(payload)) return payload as Prisma.InputJsonValue;
  if (legacyDocumentFields(payload).length === 0) return payload as Prisma.InputJsonValue;

  const cleaned = { ...payload } as Record<string, Prisma.JsonValue>;
  for (const field of LEGACY_GAP_ANALYSIS_DOCUMENT_FIELDS) delete cleaned[field];

  return {
    ...cleaned,
    payloadScrubbedAt: scrubbedAt,
  } as Prisma.InputJsonValue;
}

function isTerminal(status: string): boolean {
  return (TERMINAL_GAP_ANALYSIS_JOB_STATUSES as readonly string[]).includes(status);
}

function isActive(status: string): boolean {
  return (ACTIVE_GAP_ANALYSIS_JOB_STATUSES as readonly string[]).includes(status);
}

/**
 * Inspects only durable Gap Analysis pipeline jobs. Active/retryable legacy
 * payloads are deliberately retained until they reach a terminal state because
 * they may still depend on the legacy in-payload compatibility path.
 */
export async function cleanupLegacyGapAnalysisPayloads(
  client: CleanupClient,
  options: { execute?: boolean; batchSize?: number; now?: () => Date } = {},
): Promise<GapAnalysisPayloadCleanupSummary> {
  const execute = options.execute === true;
  const batchSize = options.batchSize ?? 100;
  const now = options.now ?? (() => new Date());
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new Error('batchSize must be an integer between 1 and 1000');
  }

  const summary: GapAnalysisPayloadCleanupSummary = {
    dryRun: !execute,
    rowsInspected: 0,
    legacyPayloadsDetected: 0,
    terminalAndSafeToScrub: 0,
    activeOrRetryable: 0,
    activeWithSupportedFileContentFallback: 0,
    activeWithUnsupportedLegacyShape: 0,
    unknownStatus: 0,
    alreadyClean: 0,
    rowsScrubbed: 0,
    documentsPrinted: 0,
    statusCounts: {},
    fieldCounts: { fileContent: 0, base64: 0, fileBuffer: 0, rawText: 0 },
  };

  let cursor: string | undefined;
  while (true) {
    const rows = await client.aiJob.findMany({
      where: {
        type: 'GAP_ANALYSIS_PIPELINE',
        targetEntityType: 'GapAnalysis',
      },
      select: { id: true, status: true, payload: true },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }) as CleanupRow[];

    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    const terminalRowsToScrub: CleanupRow[] = [];

    for (const row of rows) {
      summary.rowsInspected++;
      summary.statusCounts[row.status] = (summary.statusCounts[row.status] ?? 0) + 1;
      const fields = legacyDocumentFields(row.payload);
      if (fields.length === 0) {
        summary.alreadyClean++;
        continue;
      }

      summary.legacyPayloadsDetected++;
      for (const field of fields as Array<keyof typeof summary.fieldCounts>) {
        summary.fieldCounts[field]++;
      }

      if (isTerminal(row.status)) {
        summary.terminalAndSafeToScrub++;
        terminalRowsToScrub.push(row);
      } else if (isActive(row.status)) {
        summary.activeOrRetryable++;
        if (fields.includes('fileContent')) {
          summary.activeWithSupportedFileContentFallback++;
        } else {
          summary.activeWithUnsupportedLegacyShape++;
        }
      } else {
        // Unknown states are conservatively retained, never guessed terminal.
        summary.unknownStatus++;
      }
    }

    if (execute && terminalRowsToScrub.length > 0) {
      const scrubbedAt = now().toISOString();
      await client.$transaction(async (tx) => {
        for (const row of terminalRowsToScrub) {
          await tx.aiJob.update({
            where: { id: row.id },
            data: { payload: scrubLegacyDocumentFields(row.payload, scrubbedAt) },
          });
        }
      });
      summary.rowsScrubbed += terminalRowsToScrub.length;
    }
  }

  if (execute) {
    await client.auditLog.create({
      data: {
        action: 'GAP_ANALYSIS_LEGACY_PAYLOAD_CLEANUP',
        entityType: 'AiJob',
        metadata: {
          rowsInspected: summary.rowsInspected,
          legacyPayloadsDetected: summary.legacyPayloadsDetected,
          terminalRowsScrubbed: summary.rowsScrubbed,
          activeOrRetryableRetained: summary.activeOrRetryable,
          activeWithSupportedFileContentFallback: summary.activeWithSupportedFileContentFallback,
          activeWithUnsupportedLegacyShape: summary.activeWithUnsupportedLegacyShape,
          unknownStatusRetained: summary.unknownStatus,
          documentsPrinted: 0,
        },
      },
    });
  }

  return summary;
}
