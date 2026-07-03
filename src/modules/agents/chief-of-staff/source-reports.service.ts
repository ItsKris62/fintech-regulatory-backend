import type { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import type { SourceAgentType, SourceReportExtract } from './types';
import { SOURCE_AGENT_TYPES, extractStringsAndCounts } from './types';

interface AgentReportRow {
  id: string;
  summary: string | null;
  risks: Prisma.JsonValue | null;
  recommendedActions: Prisma.JsonValue | null;
  createdAt: Date;
}

interface SourceReportsPrisma {
  agentReport: {
    findFirst(args: object): Promise<AgentReportRow | null>;
  };
}

export interface SourceReportsDependencies {
  prisma?: SourceReportsPrisma;
}

function emptyExtract(agentType: SourceAgentType): SourceReportExtract {
  return { agentType, reportId: null, createdAt: null, summary: null, riskNotes: [], actionNotes: [], itemCounts: {} };
}

/**
 * Reads only via direct Prisma queries against the shared AgentReport/AgentRun
 * tables - never by importing or calling another batch's service class
 * (marketing.agent.ts, sales-growth.agent.ts, product-bi.agent.ts,
 * security-ops.agent.ts, reg-intel.agent.ts are all "consume, never modify").
 */
export class ChiefOfStaffSourceReportsService {
  private readonly prisma: SourceReportsPrisma;

  constructor(dependencies: SourceReportsDependencies = {}) {
    this.prisma = dependencies.prisma ?? (defaultPrisma as unknown as SourceReportsPrisma);
  }

  async fetchAllSourceReports(): Promise<SourceReportExtract[]> {
    const rows = await Promise.all(
      SOURCE_AGENT_TYPES.map((agentType) =>
        this.prisma.agentReport.findFirst({
          where: { run: { agentType } },
          orderBy: { createdAt: 'desc' },
        }),
      ),
    );

    return SOURCE_AGENT_TYPES.map((agentType, index) => {
      const row = rows[index];
      if (!row) return emptyExtract(agentType);

      const risksExtract = extractStringsAndCounts(row.risks);
      const actionsExtract = extractStringsAndCounts(row.recommendedActions);

      return {
        agentType,
        reportId: row.id,
        createdAt: row.createdAt.toISOString(),
        summary: row.summary,
        riskNotes: risksExtract.strings,
        actionNotes: actionsExtract.strings,
        itemCounts: { ...risksExtract.counts, ...actionsExtract.counts },
      };
    });
  }
}

export const chiefOfStaffSourceReportsService = new ChiefOfStaffSourceReportsService();
