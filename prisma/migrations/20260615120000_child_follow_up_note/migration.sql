-- CreateEnum
CREATE TYPE "FollowUpNoteCategory" AS ENUM ('ACTIVITY', 'MEAL', 'NAP', 'MOOD', 'CARE');

-- CreateEnum
CREATE TYPE "FollowUpNoteStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateTable
CREATE TABLE "ChildFollowUpNote" (
    "id" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "category" "FollowUpNoteCategory" NOT NULL,
    "content" TEXT NOT NULL,
    "status" "FollowUpNoteStatus" NOT NULL DEFAULT 'DRAFT',
    "noteDate" DATE NOT NULL,
    "authorId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChildFollowUpNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChildFollowUpNote_childId_noteDate_idx" ON "ChildFollowUpNote"("childId", "noteDate");

-- CreateIndex
CREATE INDEX "ChildFollowUpNote_childId_status_idx" ON "ChildFollowUpNote"("childId", "status");

-- AddForeignKey
ALTER TABLE "ChildFollowUpNote" ADD CONSTRAINT "ChildFollowUpNote_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChildFollowUpNote" ADD CONSTRAINT "ChildFollowUpNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
