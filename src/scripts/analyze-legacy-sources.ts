/**
 * Read-Only Legacy Source & Signal Analysis Script
 *
 * Inspects legacy BlogSourceMonitor, BlogSourceItem, and RegulatorySignal
 * records to report distribution, duplication, and alert associations.
 */

import { prisma } from '../lib/prisma/client';
import { logger } from '../utils/logger';

export interface LegacyAnalysisReport {
  timestamp: string;
  blogSourceMonitors: {
    total: number;
    officialCount: number;
    byJurisdiction: Record<string, number>;
  };
  blogSourceItems: {
    total: number;
    byJurisdiction: Record<string, number>;
    withRegulatorySignals: number;
  };
  regulatorySignals: {
    total: number;
    byJurisdiction: Record<string, number>;
    bySeverity: Record<string, number>;
  };
  regulatoryAlerts: {
    total: number;
    legacyWithoutSourceItem: number;
    linkedToSourceItem: number;
  };
}

export async function analyzeLegacySources(): Promise<LegacyAnalysisReport> {
  const [
    totalMonitors,
    officialMonitors,
    monitorsByJurisdiction,
    totalItems,
    itemsByJurisdiction,
    itemsWithSignals,
    totalSignals,
    signalsByJurisdiction,
    signalsBySeverity,
    totalAlerts,
    linkedAlerts,
  ] = await Promise.all([
    prisma.blogSourceMonitor.count({ where: { deletedAt: null } }),
    prisma.blogSourceMonitor.count({ where: { deletedAt: null, isOfficial: true } }),
    prisma.blogSourceMonitor.groupBy({
      by: ['jurisdiction'],
      _count: { id: true },
      where: { deletedAt: null },
    }),
    prisma.blogSourceItem.count({ where: { deletedAt: null } }),
    prisma.blogSourceItem.groupBy({
      by: ['jurisdiction'],
      _count: { id: true },
      where: { deletedAt: null },
    }),
    prisma.blogSourceItem.count({
      where: {
        deletedAt: null,
        regulatorySignals: { some: {} },
      },
    }),
    prisma.regulatorySignal.count(),
    prisma.regulatorySignal.groupBy({
      by: ['jurisdiction'],
      _count: { id: true },
    }),
    prisma.regulatorySignal.groupBy({
      by: ['severity'],
      _count: { id: true },
    }),
    prisma.regulatoryAlert.count(),
    prisma.regulatoryAlert.count({
      where: { primaryRegulatorySourceItemId: { not: null } },
    }),
  ]);

  const report: LegacyAnalysisReport = {
    timestamp: new Date().toISOString(),
    blogSourceMonitors: {
      total: totalMonitors,
      officialCount: officialMonitors,
      byJurisdiction: Object.fromEntries(
        monitorsByJurisdiction.map((m) => [m.jurisdiction, m._count.id])
      ),
    },
    blogSourceItems: {
      total: totalItems,
      byJurisdiction: Object.fromEntries(
        itemsByJurisdiction.map((i) => [i.jurisdiction, i._count.id])
      ),
      withRegulatorySignals: itemsWithSignals,
    },
    regulatorySignals: {
      total: totalSignals,
      byJurisdiction: Object.fromEntries(
        signalsByJurisdiction.map((s) => [s.jurisdiction, s._count.id])
      ),
      bySeverity: Object.fromEntries(
        signalsBySeverity.map((s) => [s.severity, s._count.id])
      ),
    },
    regulatoryAlerts: {
      total: totalAlerts,
      legacyWithoutSourceItem: totalAlerts - linkedAlerts,
      linkedToSourceItem: linkedAlerts,
    },
  };

  return report;
}

if (require.main === module) {
  analyzeLegacySources()
    .then((report) => {
      console.log('Legacy Regulatory Source Analysis Report:');
      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    })
    .catch((error) => {
      logger.error({ type: 'legacy_analysis_failed', error });
      console.error('Failed to run legacy source analysis:', error);
      process.exit(1);
    });
}
