-- AlterTable
ALTER TABLE "Workshop" ADD COLUMN "endDate" DATE;

UPDATE "Workshop" SET "endDate" = "eventDate" WHERE "endDate" IS NULL;

ALTER TABLE "Workshop" ALTER COLUMN "endDate" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Workshop_endDate_idx" ON "Workshop"("endDate");
