/*
  Warnings:

  - The `regulatoryAreas` column on the `ComplianceQuery` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "ComplianceQuery" DROP COLUMN "regulatoryAreas",
ADD COLUMN     "regulatoryAreas" JSONB;
