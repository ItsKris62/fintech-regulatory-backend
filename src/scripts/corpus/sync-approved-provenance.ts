import { prisma } from '@/lib/prisma/client';
import { loadManifest } from './manifest-loader';

const WRITE = process.argv.includes('--write');
const COUNTRY = 'Nigeria' as const;

function allowedDomains(sourceUrl: string): string[] {
  return [new URL(sourceUrl).hostname.toLowerCase()];
}

async function main(): Promise<void> {
  const loaded = loadManifest(COUNTRY);
  if (!loaded.manifest || loaded.errors.length > 0) {
    throw new Error(`Nigeria manifest is invalid: ${loaded.errors.map((error) => error.message).join('; ')}`);
  }

  const approved = loaded.validEntries.filter((entry) => entry.reviewStatus === 'APPROVED');
  const superseded = loaded.validEntries.filter((entry) => entry.reviewStatus === 'SUPERSEDED');
  let matched = 0;
  let changed = 0;
  let supersededMatched = 0;
  let supersededChanged = 0;

  for (const entry of superseded) {
    if (!entry.checksumSha256) throw new Error(`Superseded entry ${entry.id} lacks checksum`);
    const documents = await prisma.regulatoryDocument.findMany({
      where: { checksum: entry.checksumSha256, jurisdictionCode: 'NG', status: { in: ['ACTIVE', 'SUPERSEDED'] } },
      select: { id: true, metadata: true },
    });
    if (documents.length !== 1) {
      throw new Error(`${entry.id}: expected one lifecycle checksum match, found ${documents.length}`);
    }
    supersededMatched += 1;
    if (!WRITE) continue;

    await prisma.$transaction(async (tx) => {
      await tx.sourceDocumentVersion.updateMany({
        where: { regulatoryDocumentId: documents[0].id, status: 'ACTIVE' },
        data: { status: 'SUPERSEDED', authorityStatus: 'SUPERSEDED' },
      });
      const previousMetadata = documents[0].metadata && typeof documents[0].metadata === 'object'
        ? documents[0].metadata as Record<string, unknown>
        : {};
      await tx.regulatoryDocument.update({
        where: { id: documents[0].id },
        data: {
          status: 'SUPERSEDED',
          authorityStatus: 'SUPERSEDED',
          officialUrl: entry.sourceUrl ?? undefined,
          metadata: {
            ...previousMetadata,
            manifestId: entry.id,
            reviewStatus: 'SUPERSEDED',
            operatorProvenanceAttested: true,
          },
        },
      });
    }, { maxWait: 30_000, timeout: 30_000 });
    supersededChanged += 1;
  }

  for (const entry of approved) {
    if (!entry.checksumSha256 || !entry.sourceUrl) {
      throw new Error(`Approved entry ${entry.id} lacks checksum or sourceUrl`);
    }

    const documents = await prisma.regulatoryDocument.findMany({
      where: { checksum: entry.checksumSha256, jurisdictionCode: 'NG', status: 'ACTIVE' },
      select: { id: true, metadata: true },
    });
    if (documents.length !== 1) {
      throw new Error(`${entry.id}: expected one ACTIVE checksum match, found ${documents.length}`);
    }
    matched += 1;
    if (!WRITE) continue;

    await prisma.$transaction(async (tx) => {
      const baseUrl = new URL(entry.sourceUrl!).origin;
      let source = await tx.approvedSource.findFirst({
        where: {
          jurisdiction: 'Nigeria',
          authorityName: entry.regulator,
          status: 'ACTIVE',
          allowedDomains: { equals: allowedDomains(entry.sourceUrl!) },
        },
      });
      source ??= await tx.approvedSource.create({
        data: {
          jurisdiction: 'Nigeria',
          authorityName: entry.regulator,
          authorityType: 'OFFICIAL_ISSUING_AUTHORITY',
          baseUrl,
          allowedDomains: allowedDomains(entry.sourceUrl!),
          status: 'ACTIVE',
          reviewedAt: new Date(),
          notes: 'Document-specific provenance approved from the Nigeria corpus manifest; operator attestation retained in manifest notes.',
        },
      });

      let version = await tx.sourceDocumentVersion.findFirst({
        where: {
          regulatoryDocumentId: documents[0].id,
          checksumSha256: entry.checksumSha256,
          officialUrl: entry.sourceUrl!,
          approvedSourceId: source.id,
          status: 'ACTIVE',
        },
      });
      version ??= await tx.sourceDocumentVersion.create({
        data: {
          regulatoryDocumentId: documents[0].id,
          approvedSourceId: source.id,
          officialUrl: entry.sourceUrl!,
          publicationDate: entry.publicationDate ? new Date(entry.publicationDate) : undefined,
          effectiveDate: entry.effectiveDate ? new Date(entry.effectiveDate) : undefined,
          versionLabel: entry.version ?? undefined,
          checksumSha256: entry.checksumSha256,
          authorityStatus: entry.authorityStatus === 'IN_FORCE' ? 'IN_FORCE' : 'DRAFT',
          isBinding: entry.isBinding,
          status: 'ACTIVE',
        },
      });

      const previousMetadata = documents[0].metadata && typeof documents[0].metadata === 'object'
        ? documents[0].metadata as Record<string, unknown>
        : {};
      await tx.regulatoryDocument.update({
        where: { id: documents[0].id },
        data: {
          source: entry.regulator,
          authorityStatus: 'IN_FORCE',
          isBinding: entry.isBinding,
          officialUrl: entry.sourceUrl!,
          sourceRegistryId: source.id,
          sourceDocumentVersionId: version.id,
          metadata: {
            ...previousMetadata,
            manifestId: entry.id,
            reviewStatus: 'APPROVED',
            provenanceConfidence: 'VERIFIED_CONTENT_MATCH',
            operatorProvenanceAttested: true,
          },
        },
      });
    }, { maxWait: 30_000, timeout: 30_000 });
    changed += 1;
  }

  console.log(JSON.stringify({
    mode: WRITE ? 'WRITE' : 'DRY_RUN',
    approved: approved.length,
    matched,
    changed,
    superseded: superseded.length,
    supersededMatched,
    supersededChanged,
  }));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
