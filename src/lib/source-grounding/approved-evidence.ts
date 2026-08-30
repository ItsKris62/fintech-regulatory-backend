import { prisma } from '@/lib/prisma/client';
import { isOfficialUrlAllowed } from '@/lib/source-grounding/source-metadata';
import type { SearchResult } from '@/lib/rag/rag.service';
import { isJurisdictionCode, type JurisdictionCode } from '@/types/jurisdiction';

type ApprovalLookupClient = Pick<typeof prisma, 'regulatoryDocument'>;

/**
 * NG is the first corpus migrated to strict registry-backed approval. Keeping
 * this explicit avoids silently breaking already-certified legacy corpora
 * while their ApprovedSource records are reconciled in separate work.
 */
const STRICT_APPROVAL_JURISDICTIONS = new Set<JurisdictionCode>(['NG']);

export interface ApprovedEvidencePartition {
  eligible: SearchResult[];
  ineligible: SearchResult[];
  enforcementApplied: boolean;
}

export async function partitionEvidenceBySourceApproval(
  results: SearchResult[],
  jurisdictionCodes: readonly JurisdictionCode[],
  db: ApprovalLookupClient = prisma,
): Promise<ApprovedEvidencePartition> {
  const strictCodes = jurisdictionCodes.filter((code) => STRICT_APPROVAL_JURISDICTIONS.has(code));
  if (strictCodes.length === 0 || results.length === 0) {
    return { eligible: results, ineligible: [], enforcementApplied: false };
  }

  const documentIds = [...new Set(results.map((result) => result.documentId).filter(Boolean))];
  if (documentIds.length === 0) {
    return { eligible: [], ineligible: results, enforcementApplied: true };
  }

  const documents = await db.regulatoryDocument.findMany({
    where: {
      id: { in: documentIds },
      jurisdictionCode: { in: strictCodes },
      status: 'ACTIVE',
      sourceDocumentVersion: {
        is: {
          status: 'ACTIVE',
          approvedSource: { is: { status: 'ACTIVE' } },
        },
      },
    },
    select: {
      id: true,
      source: true,
      jurisdictionCode: true,
      authorityStatus: true,
      officialUrl: true,
      metadata: true,
      sourceDocumentVersion: {
        select: {
          officialUrl: true,
          approvedSource: { select: { baseUrl: true, allowedDomains: true } },
        },
      },
    },
  });

  const approvedIds = new Set(
    documents
      .filter((document) => isOfficialUrlAllowed(
        document.sourceDocumentVersion?.officialUrl,
        document.sourceDocumentVersion?.approvedSource,
      ))
      .map((document) => document.id),
  );
  const approvedDocuments = new Map(documents.map((document) => [document.id, document]));

  return {
    eligible: results
      .filter((result) => approvedIds.has(result.documentId))
      .map((result) => {
        const document = approvedDocuments.get(result.documentId)!;
        const metadata = document.metadata && typeof document.metadata === 'object'
          ? document.metadata as Record<string, unknown>
          : {};
        return {
          ...result,
          source: document.source,
          jurisdictionCode: isJurisdictionCode(document.jurisdictionCode)
            ? document.jurisdictionCode
            : result.jurisdictionCode,
          authorityStatus: document.authorityStatus,
          officialUrl: document.sourceDocumentVersion?.officialUrl ?? document.officialUrl ?? result.officialUrl,
          approvalStatus: 'APPROVED' as const,
          provenanceConfidence: typeof metadata.provenanceConfidence === 'string'
            ? metadata.provenanceConfidence
            : undefined,
        };
      }),
    ineligible: results.filter((result) => !approvedIds.has(result.documentId)),
    enforcementApplied: true,
  };
}
