-- CreateEnum
CREATE TYPE "DocumentSignatureStatus" AS ENUM ('PENDING', 'SIGNED');

-- AlterTable
ALTER TABLE "Document" ADD COLUMN "requiresParentSignature" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "DocumentSignature" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "parentId" TEXT NOT NULL,
    "status" "DocumentSignatureStatus" NOT NULL DEFAULT 'PENDING',
    "signatureUrl" TEXT,
    "signedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentSignature_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentSignature_parentId_idx" ON "DocumentSignature"("parentId");

-- CreateIndex
CREATE INDEX "DocumentSignature_documentId_status_idx" ON "DocumentSignature"("documentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentSignature_documentId_parentId_key" ON "DocumentSignature"("documentId", "parentId");

-- AddForeignKey
ALTER TABLE "DocumentSignature" ADD CONSTRAINT "DocumentSignature_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentSignature" ADD CONSTRAINT "DocumentSignature_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
