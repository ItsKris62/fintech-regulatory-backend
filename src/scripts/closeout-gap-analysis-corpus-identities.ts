import 'dotenv/config';

import { prisma } from '@/lib/prisma/client';
import { getIndex, getIndexStats, resolvePineconeNamespace } from '@/lib/rag/client';
import {
  getCorpusSourceSetFingerprintSnapshot,
  getCorpusVersionSnapshot,
} from '@/lib/rag/corpus-version';
import type { JurisdictionCode } from '@/types/jurisdiction';

const WRITE = process.argv.includes('--write');
const EXPECTED_NAMESPACE = 'batch63-development-uat';
const UPDATED_BY = 'gap-analysis-provider-independent-closeout';

const TARGETS = [
  { jurisdictionCode: 'KE', frameworkSlug: 'dpa-2019', expectedCount: 396 },
  { jurisdictionCode: 'RW', frameworkSlug: 'rw-dpa-2021', expectedCount: 206 },
  { jurisdictionCode: 'MW', frameworkSlug: 'mw-cybersecurity-2016', expectedCount: 687 },
  { jurisdictionCode: 'NG', frameworkSlug: 'ndpa-2023', expectedCount: 423 },
] as const satisfies ReadonlyArray<{
  jurisdictionCode: JurisdictionCode;
  frameworkSlug: string;
  expectedCount: number;
}>;

type PilotDocumentRow = {
  id: string;
  jurisdictionCode: JurisdictionCode;
  frameworkSlug: string;
  checksum: string | null;
  sourceDocumentVersionId: string | null;
  approvedSourceStatus: string | null;
  sourceVersionStatus: string | null;
};

type PilotChunkRow = {
  pineconeId: string;
  chunkIndex: number;
  contentHash: string | null;
};

type DuplicateClassification = {
  contentHash: string;
  chunkIndexes: readonly number[];
  classification: 'LEGITIMATE_REPEATED_TEXT';
  basis: string;
};

const CLASSIFIED_DUPLICATE_CONTENT_HASHES: Partial<Record<JurisdictionCode, readonly DuplicateClassification[]>> = {
  RW: [{
    contentHash: 'd19c72de8f60ba3d358e2a6095db0061ceb4fee7cb8a50b89ba3d6c152534b7d',
    chunkIndexes: [117, 126],
    classification: 'LEGITIMATE_REPEATED_TEXT',
    basis: 'Same appeal wording occurs under distinct Articles 20 and 23 with distinct provision identities.',
  }],
  MW: [
    {
      contentHash: '5e4ceb6246abd1518744ea77b4161ca2ec1432f64f106a1c4bd4176a3137df02',
      chunkIndexes: [123, 131],
      classification: 'LEGITIMATE_REPEATED_TEXT',
      basis: 'Source license text occurs at distinct page boundaries with distinct surrounding source text.',
    },
    {
      contentHash: '53de8eef54c131499421bab7dfdfc45e6707905667a12309d3181f4b9bdacf7e',
      chunkIndexes: [455, 458],
      classification: 'LEGITIMATE_REPEATED_TEXT',
      basis: 'Same subsection text occurs under distinct Sections 52 and 53 with distinct surrounding provisions.',
    },
  ],
};

function duplicates<T>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const found = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) found.add(value);
    seen.add(value);
  }
  return [...found];
}

function assertDevelopmentUat(): void {
  const databaseEnvironment = (process.env.DATABASE_ENVIRONMENT ?? '').trim().toLowerCase();
  const nodeEnvironment = (process.env.NODE_ENV ?? '').trim().toLowerCase();
  const namespace = resolvePineconeNamespace();
  if (databaseEnvironment !== 'development-uat') {
    throw new Error(`Blocked: DATABASE_ENVIRONMENT must be development-uat, received ${databaseEnvironment || '(missing)'}.`);
  }
  if (nodeEnvironment === 'production') {
    throw new Error('Blocked: NODE_ENV=production.');
  }
  if (namespace !== EXPECTED_NAMESPACE) {
    throw new Error(`Blocked: Pinecone namespace must be ${EXPECTED_NAMESPACE}, received ${namespace || '(default)'}.`);
  }
}

async function main() {
  assertDevelopmentUat();

  const namespace = resolvePineconeNamespace();
  const documents = await prisma.$queryRaw<PilotDocumentRow[]>`
    SELECT
      document."id",
      document."jurisdictionCode",
      document."metadata" ->> 'frameworkSlug' AS "frameworkSlug",
      document."checksum",
      document."sourceDocumentVersionId",
      approved."status"::text AS "approvedSourceStatus",
      source_version."status"::text AS "sourceVersionStatus"
    FROM "RegulatoryDocument" AS document
    LEFT JOIN "ApprovedSource" AS approved
      ON approved."id" = document."sourceRegistryId"
    LEFT JOIN "SourceDocumentVersion" AS source_version
      ON source_version."id" = document."sourceDocumentVersionId"
    WHERE document."status" = 'ACTIVE'
      AND (document."jurisdictionCode", document."metadata" ->> 'frameworkSlug') IN (
        ('KE', 'dpa-2019'),
        ('RW', 'rw-dpa-2021'),
        ('MW', 'mw-cybersecurity-2016'),
        ('NG', 'ndpa-2023')
      )
  `;
  console.error(`[corpus-closeout] loaded ${documents.length} active pilot-jurisdiction document(s)`);

  const index = await getIndex();
  const stats = await getIndexStats();
  console.error(`[corpus-closeout] loaded Pinecone stats for namespace ${namespace}`);
  const findings: Array<Record<string, unknown>> = [];
  const failures: string[] = [];

  for (const target of TARGETS) {
    const matches = documents.filter((document) => {
      return document.jurisdictionCode === target.jurisdictionCode
        && document.frameworkSlug === target.frameworkSlug;
    });
    if (matches.length !== 1) {
      failures.push(`${target.jurisdictionCode}/${target.frameworkSlug}: expected one ACTIVE document, found ${matches.length}`);
      continue;
    }

    const document = matches[0];
    const chunks = await prisma.$queryRaw<PilotChunkRow[]>`
      SELECT "pineconeId", "chunkIndex", "contentHash"
      FROM "RegulatoryDocumentChunk"
      WHERE "documentId" = ${document.id}
      ORDER BY "chunkIndex"
    `;
    console.error(`[corpus-closeout] loaded ${chunks.length} DB chunk(s) for ${target.jurisdictionCode}/${target.frameworkSlug}`);
    const pineconeIds = chunks.map((chunk) => chunk.pineconeId);
    const duplicatePineconeIds = duplicates(pineconeIds);
    const duplicateChunkIndexes = duplicates(chunks.map((chunk) => chunk.chunkIndex));
    const contentHashes = chunks
      .map((chunk) => chunk.contentHash)
      .filter((value): value is string => Boolean(value));
    const duplicateContentHashes = duplicates(contentHashes);
    const classifiedDuplicateContentHashes = duplicateContentHashes.map((contentHash) => {
      const actualIndexes = chunks
        .filter((chunk) => chunk.contentHash === contentHash)
        .map((chunk) => chunk.chunkIndex)
        .sort((left, right) => left - right);
      const classification = CLASSIFIED_DUPLICATE_CONTENT_HASHES[target.jurisdictionCode]
        ?.find((entry) => entry.contentHash === contentHash);
      const expectedIndexes = classification
        ? [...classification.chunkIndexes].sort((left, right) => left - right)
        : [];
      const exactMembership = JSON.stringify(actualIndexes) === JSON.stringify(expectedIndexes);
      return {
        contentHash,
        actualIndexes,
        classification: exactMembership ? classification?.classification ?? null : null,
        basis: exactMembership ? classification?.basis ?? null : null,
      };
    });
    const unclassifiedDuplicateContentHashes = classifiedDuplicateContentHashes
      .filter((entry) => entry.classification === null);
    const missingContentHashes = chunks.length - contentHashes.length;
    const fetched = new Map<string, Record<string, unknown>>();

    const batches = Array.from(
      { length: Math.ceil(pineconeIds.length / 100) },
      (_, batchIndex) => pineconeIds.slice(batchIndex * 100, (batchIndex + 1) * 100),
    );
    const responses = await Promise.all(batches.map((ids) => index.fetch({ ids, namespace })));
    for (const response of responses) {
      for (const [id, record] of Object.entries(response.records)) {
        fetched.set(id, (record.metadata ?? {}) as Record<string, unknown>);
      }
    }
    console.error(`[corpus-closeout] verified ${target.jurisdictionCode}/${target.frameworkSlug}: ${fetched.size} vector(s)`);

    const missingVectorIds = pineconeIds.filter((id) => !fetched.has(id));
    const metadataMismatches: string[] = [];
    for (const [id, metadata] of fetched) {
      if (metadata.documentId !== document.id) metadataMismatches.push(`${id}:documentId`);
      if (metadata.jurisdictionCode !== target.jurisdictionCode) metadataMismatches.push(`${id}:jurisdictionCode`);
      if (metadata.frameworkSlug !== target.frameworkSlug) metadataMismatches.push(`${id}:frameworkSlug`);
      if (metadata.documentChecksum !== document.checksum) metadataMismatches.push(`${id}:documentChecksum`);
      if (metadata.sourceDocumentVersionId !== document.sourceDocumentVersionId) metadataMismatches.push(`${id}:sourceDocumentVersionId`);
    }

    const linkedApprovedSource = document.approvedSourceStatus === 'ACTIVE';
    const linkedActiveVersion = document.sourceVersionStatus === 'ACTIVE';
    const actualCount = chunks.length;
    const targetFailures = [
      actualCount !== target.expectedCount ? `DB chunks ${actualCount} != expected ${target.expectedCount}` : null,
      fetched.size !== target.expectedCount ? `vectors ${fetched.size} != expected ${target.expectedCount}` : null,
      duplicatePineconeIds.length ? `duplicate Pinecone IDs ${duplicatePineconeIds.length}` : null,
      duplicateChunkIndexes.length ? `duplicate chunk indexes ${duplicateChunkIndexes.length}` : null,
      missingContentHashes ? `missing content hashes ${missingContentHashes}` : null,
      unclassifiedDuplicateContentHashes.length
        ? `unclassified duplicate content hashes ${unclassifiedDuplicateContentHashes.length}`
        : null,
      missingVectorIds.length ? `missing vectors ${missingVectorIds.length}` : null,
      metadataMismatches.length ? `vector metadata mismatches ${metadataMismatches.length}` : null,
      !linkedApprovedSource ? 'approved source linkage is missing or inactive' : null,
      !linkedActiveVersion ? 'source version linkage is missing or inactive' : null,
    ].filter((value): value is string => Boolean(value));

    failures.push(...targetFailures.map((failure) => `${target.jurisdictionCode}/${target.frameworkSlug}: ${failure}`));
    findings.push({
      jurisdictionCode: target.jurisdictionCode,
      frameworkSlug: target.frameworkSlug,
      canonicalDocumentSourceCount: matches.length,
      documentChecksum: document.checksum,
      dbChunkCount: actualCount,
      pineconeVectorCount: fetched.size,
      approvedSourceLinked: linkedApprovedSource,
      sourceVersionLinked: linkedActiveVersion,
      missingVectorIds: missingVectorIds.length,
      duplicatePineconeIds: duplicatePineconeIds.length,
      duplicateChunkIndexes: duplicateChunkIndexes.length,
      missingContentHashes,
      duplicateContentHashes: duplicateContentHashes.length,
      classifiedDuplicateContentHashes,
      metadataMismatches: metadataMismatches.length,
    });
  }

  const expectedTotal = TARGETS.reduce((total, target) => total + target.expectedCount, 0);
  const namespaceCount = stats.namespaces?.[namespace]?.recordCount ?? null;
  if (namespaceCount !== expectedTotal) {
    failures.push(`namespace ${namespace} has ${namespaceCount ?? 'unknown'} vectors; expected ${expectedTotal}`);
  }
  if (failures.length > 0) {
    console.log(JSON.stringify({ mode: WRITE ? 'WRITE_BLOCKED' : 'DRY_RUN_FAILED', namespace, findings, failures }, null, 2));
    throw new Error(`Corpus identity closeout blocked by ${failures.length} integrity failure(s).`);
  }

  const jurisdictionCodes = TARGETS.map((target) => target.jurisdictionCode);
  const before = await getCorpusVersionSnapshot({
    mode: 'COMPARE',
    jurisdictions: jurisdictionCodes,
    jurisdictionSource: 'REQUEST',
  });
  const fingerprintsBefore = await getCorpusSourceSetFingerprintSnapshot({
    mode: 'COMPARE',
    jurisdictions: jurisdictionCodes,
    jurisdictionSource: 'REQUEST',
  });
  console.error('[corpus-closeout] computed pre-write corpus snapshots');

  if (WRITE) {
    await prisma.$transaction(
      TARGETS.map((target) => prisma.jurisdictionCorpusVersion.upsert({
        where: { jurisdictionCode: target.jurisdictionCode },
        create: {
          jurisdictionCode: target.jurisdictionCode,
          version: 1,
          reason: `Deterministic active approved source-set identity initialized for ${target.frameworkSlug}`,
          updatedBy: UPDATED_BY,
        },
        update: {},
      })),
    );
  }

  const after = await getCorpusVersionSnapshot({
    mode: 'COMPARE',
    jurisdictions: jurisdictionCodes,
    jurisdictionSource: 'REQUEST',
  });
  const fingerprintsAfter = await getCorpusSourceSetFingerprintSnapshot({
    mode: 'COMPARE',
    jurisdictions: jurisdictionCodes,
    jurisdictionSource: 'REQUEST',
  });
  console.error('[corpus-closeout] computed post-write corpus snapshots');

  console.log(JSON.stringify({
    mode: WRITE ? 'WRITE' : 'DRY_RUN',
    namespace,
    namespaceVectorCount: namespaceCount,
    expectedTotal,
    findings,
    fingerprintsBefore,
    fingerprintsAfter,
    corpusVersionsBefore: before,
    corpusVersionsAfter: after,
  }, null, 2));
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
