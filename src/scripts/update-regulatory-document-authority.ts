/**
 * Update regulatory document authority metadata and refresh Pinecone records.
 *
 * Examples:
 *   pnpm regdoc:authority -- --document-id cm123 --authority-status IN_FORCE --binding true --version 2026
 *   pnpm regdoc:authority -- --title-contains "Draft Banking" --authority-status SUPERSEDED --binding false
 */

import { prisma } from '@/lib/prisma/client'
import { documentIngestionService } from '@/lib/ingestion/document-processor'

type AuthorityStatus = 'DRAFT' | 'IN_FORCE' | 'SUPERSEDED' | 'CONSULTATION'

const VALID_AUTHORITY_STATUSES: AuthorityStatus[] = [
  'DRAFT',
  'IN_FORCE',
  'SUPERSEDED',
  'CONSULTATION',
]

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`)
  return idx >= 0 ? process.argv[idx + 1] : undefined
}

function parseBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`--binding must be "true" or "false", got "${raw}"`)
}

async function resolveDocumentId(): Promise<string> {
  const documentId = getArg('document-id')
  if (documentId) return documentId

  const titleContains = getArg('title-contains')
  if (!titleContains) {
    throw new Error('Provide --document-id or --title-contains')
  }

  const matches = await (prisma as any).regulatoryDocument.findMany({
    where: { title: { contains: titleContains, mode: 'insensitive' } },
    select: { id: true, title: true, authorityStatus: true, version: true },
    take: 10,
  })

  if (matches.length === 0) {
    throw new Error(`No regulatory document matched "${titleContains}"`)
  }

  if (matches.length > 1) {
    const list = matches
      .map((doc: any) => `- ${doc.id}: ${doc.title} (${doc.authorityStatus}, ${doc.version ?? 'no version'})`)
      .join('\n')
    throw new Error(`Multiple documents matched. Re-run with --document-id:\n${list}`)
  }

  return matches[0].id
}

async function main() {
  const authorityStatus = getArg('authority-status') as AuthorityStatus | undefined
  if (!authorityStatus || !VALID_AUTHORITY_STATUSES.includes(authorityStatus)) {
    throw new Error(`--authority-status must be one of: ${VALID_AUTHORITY_STATUSES.join(', ')}`)
  }

  const documentId = await resolveDocumentId()
  const binding = parseBoolean(getArg('binding'))
  const version = getArg('version')
  const effectiveDateRaw = getArg('effective-date')
  const effectiveDate = effectiveDateRaw ? new Date(effectiveDateRaw) : undefined

  if (effectiveDate && Number.isNaN(effectiveDate.getTime())) {
    throw new Error(`Invalid --effective-date: ${effectiveDateRaw}`)
  }

  await documentIngestionService.updateDocumentAuthority(documentId, {
    authorityStatus,
    isBinding: binding,
    version,
    effectiveDate,
  })

  const updated = await (prisma as any).regulatoryDocument.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      title: true,
      authorityStatus: true,
      isBinding: true,
      status: true,
      version: true,
      effectiveDate: true,
    },
  })

  console.log(JSON.stringify(updated, null, 2))
}

main()
  .catch((error: Error) => {
    console.error(error.message)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
