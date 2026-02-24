-- CreateEnum
CREATE TYPE "RegulatoryDocumentCategory" AS ENUM ('DATA_PROTECTION', 'CYBERSECURITY', 'FINTECH_REGULATION', 'AML_CFT', 'PAYMENT_SYSTEMS', 'INTERNATIONAL_STANDARD');

-- CreateEnum
CREATE TYPE "RegulatoryDocumentStatus" AS ENUM ('PENDING', 'PROCESSING', 'ACTIVE', 'FAILED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "RegulatoryDocument" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "category" "RegulatoryDocumentCategory" NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3),
    "version" TEXT,
    "storageKey" TEXT NOT NULL,
    "status" "RegulatoryDocumentStatus" NOT NULL DEFAULT 'PENDING',
    "checksum" TEXT,
    "chunkCount" INTEGER,
    "totalCharacters" INTEGER,
    "processedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegulatoryDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegulatoryDocumentChunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "section" TEXT,
    "tokenCount" INTEGER NOT NULL,
    "pineconeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegulatoryDocumentChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RegulatoryDocument_status_idx" ON "RegulatoryDocument"("status");

-- CreateIndex
CREATE INDEX "RegulatoryDocument_category_idx" ON "RegulatoryDocument"("category");

-- CreateIndex
CREATE INDEX "RegulatoryDocument_jurisdiction_idx" ON "RegulatoryDocument"("jurisdiction");

-- CreateIndex
CREATE INDEX "RegulatoryDocument_checksum_idx" ON "RegulatoryDocument"("checksum");

-- CreateIndex
CREATE UNIQUE INDEX "RegulatoryDocumentChunk_pineconeId_key" ON "RegulatoryDocumentChunk"("pineconeId");

-- CreateIndex
CREATE INDEX "RegulatoryDocumentChunk_documentId_idx" ON "RegulatoryDocumentChunk"("documentId");

-- AddForeignKey
ALTER TABLE "RegulatoryDocumentChunk" ADD CONSTRAINT "RegulatoryDocumentChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "RegulatoryDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
