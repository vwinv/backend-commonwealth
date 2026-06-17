-- CreateEnum
CREATE TYPE "ProgramCategory" AS ENUM ('SORTIE_SCOLAIRE', 'PARENTS', 'PROFESSEURS', 'SKILLS_EVEIL');

-- CreateTable
CREATE TABLE "ProgramEvent" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "eventDate" TIMESTAMP(3) NOT NULL,
    "location" TEXT,
    "assignedStaff" TEXT,
    "category" "ProgramCategory" NOT NULL,
    "schoolYear" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgramEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramEventLevel" (
    "id" TEXT NOT NULL,
    "programEventId" TEXT NOT NULL,
    "levelId" TEXT NOT NULL,

    CONSTRAINT "ProgramEventLevel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProgramEvent_schoolYear_idx" ON "ProgramEvent"("schoolYear");

-- CreateIndex
CREATE INDEX "ProgramEvent_eventDate_idx" ON "ProgramEvent"("eventDate");

-- CreateIndex
CREATE INDEX "ProgramEvent_category_idx" ON "ProgramEvent"("category");

-- CreateIndex
CREATE INDEX "ProgramEventLevel_levelId_idx" ON "ProgramEventLevel"("levelId");

-- CreateIndex
CREATE UNIQUE INDEX "ProgramEventLevel_programEventId_levelId_key" ON "ProgramEventLevel"("programEventId", "levelId");

-- AddForeignKey
ALTER TABLE "ProgramEventLevel" ADD CONSTRAINT "ProgramEventLevel_programEventId_fkey" FOREIGN KEY ("programEventId") REFERENCES "ProgramEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramEventLevel" ADD CONSTRAINT "ProgramEventLevel_levelId_fkey" FOREIGN KEY ("levelId") REFERENCES "Level"("id") ON DELETE CASCADE ON UPDATE CASCADE;
