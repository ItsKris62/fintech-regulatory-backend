/*
  Warnings:

  - A unique constraint covering the columns `[slug]` on the table `LegalDocument` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('REGULATORY_DOCUMENT', 'BLOG_POST', 'KNOWLEDGE_BASE_ARTICLE', 'POLICY_TEMPLATE');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED', 'UNDER_REVIEW');

-- AlterTable
ALTER TABLE "LegalDocument" ADD COLUMN     "authorId" TEXT,
ADD COLUMN     "category" TEXT,
ADD COLUMN     "content" TEXT,
ADD COLUMN     "contentStatus" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
ADD COLUMN     "contentType" "ContentType" NOT NULL DEFAULT 'REGULATORY_DOCUMENT',
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "excerpt" TEXT,
ADD COLUMN     "helpfulCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "htmlContent" TEXT,
ADD COLUMN     "isLatestVersion" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notHelpfulCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "organizationId" TEXT,
ADD COLUMN     "parentId" TEXT,
ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "publishedBy" TEXT,
ADD COLUMN     "seoDescription" TEXT,
ADD COLUMN     "seoKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "seoTitle" TEXT,
ADD COLUMN     "slug" TEXT,
ADD COLUMN     "subcategory" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "title" TEXT,
ADD COLUMN     "userId" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "viewCount" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "LegalDocument_slug_key" ON "LegalDocument"("slug");

-- CreateIndex
CREATE INDEX "LegalDocument_contentType_contentStatus_idx" ON "LegalDocument"("contentType", "contentStatus");

-- CreateIndex
CREATE INDEX "LegalDocument_slug_idx" ON "LegalDocument"("slug");

-- CreateIndex
CREATE INDEX "LegalDocument_category_subcategory_idx" ON "LegalDocument"("category", "subcategory");

-- CreateIndex
CREATE INDEX "LegalDocument_organizationId_contentType_idx" ON "LegalDocument"("organizationId", "contentType");

-- CreateIndex
CREATE INDEX "LegalDocument_authorId_idx" ON "LegalDocument"("authorId");

-- AddForeignKey
ALTER TABLE "LegalDocument" ADD CONSTRAINT "LegalDocument_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegalDocument" ADD CONSTRAINT "LegalDocument_publishedBy_fkey" FOREIGN KEY ("publishedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegalDocument" ADD CONSTRAINT "LegalDocument_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "LegalDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
