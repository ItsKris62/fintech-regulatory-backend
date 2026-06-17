import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { KENYA_PRIORITY_APPROVED_SOURCES } from '@/lib/source-grounding/approved-sources';

type Options = {
  dryRun: boolean;
};

type Summary = {
  dryRun: boolean;
  scanned: number;
  created: number;
  updated: number;
  unchanged: number;
};

function parseOptions(argv: string[]): Options {
  return { dryRun: !argv.includes('--write') };
}

export async function seedApprovedSources(options: Options): Promise<Summary> {
  const summary: Summary = {
    dryRun: options.dryRun,
    scanned: KENYA_PRIORITY_APPROVED_SOURCES.length,
    created: 0,
    updated: 0,
    unchanged: 0,
  };

  for (const source of KENYA_PRIORITY_APPROVED_SOURCES) {
    const existing = await (prisma as any).approvedSource.findUnique({
      where: { id: source.id },
    });

    const data = {
      jurisdiction: source.jurisdiction,
      authorityName: source.authorityName,
      authorityType: source.authorityType,
      baseUrl: source.baseUrl,
      allowedDomains: source.allowedDomains,
      status: 'ACTIVE',
      notes: source.notes ?? 'Seeded for Source Verification Phase 4 priority corpus groundwork.',
    };

    if (!existing) {
      summary.created++;
      if (!options.dryRun) {
        await (prisma as any).approvedSource.create({
          data: { id: source.id, ...data },
        });
      }
      continue;
    }

    const changed = existing.jurisdiction !== data.jurisdiction ||
      existing.authorityName !== data.authorityName ||
      existing.authorityType !== data.authorityType ||
      existing.baseUrl !== data.baseUrl ||
      JSON.stringify(existing.allowedDomains ?? []) !== JSON.stringify(data.allowedDomains) ||
      existing.status !== data.status;

    if (changed) {
      summary.updated++;
      if (!options.dryRun) {
        await (prisma as any).approvedSource.update({
          where: { id: source.id },
          data,
        });
      }
    } else {
      summary.unchanged++;
    }
  }

  logger.info({ type: 'approved_sources_seed_complete', ...summary });
  return summary;
}

if (require.main === module) {
  seedApprovedSources(parseOptions(process.argv.slice(2)))
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
