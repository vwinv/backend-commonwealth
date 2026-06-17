-- CreateEnum
CREATE TYPE "ProgramEventStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'COMPLETED');

-- AlterTable
ALTER TABLE "ProgramEvent" ADD COLUMN "endDate" TIMESTAMP(3),
ADD COLUMN "status" "ProgramEventStatus" NOT NULL DEFAULT 'PLANNED';

-- CreateIndex
CREATE INDEX "ProgramEvent_status_idx" ON "ProgramEvent"("status");
