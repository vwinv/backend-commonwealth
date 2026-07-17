-- CreateTable
CREATE TABLE "ClassDocument" (
    "classId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassDocument_pkey" PRIMARY KEY ("classId","documentId")
);

-- CreateTable
CREATE TABLE "DocumentParent" (
    "documentId" TEXT NOT NULL,
    "parentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentParent_pkey" PRIMARY KEY ("documentId","parentId")
);

-- CreateIndex
CREATE INDEX "ClassDocument_documentId_idx" ON "ClassDocument"("documentId");

-- CreateIndex
CREATE INDEX "DocumentParent_parentId_idx" ON "DocumentParent"("parentId");

-- AddForeignKey
ALTER TABLE "ClassDocument" ADD CONSTRAINT "ClassDocument_classId_fkey" FOREIGN KEY ("classId") REFERENCES "ClassRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassDocument" ADD CONSTRAINT "ClassDocument_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentParent" ADD CONSTRAINT "DocumentParent_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentParent" ADD CONSTRAINT "DocumentParent_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
