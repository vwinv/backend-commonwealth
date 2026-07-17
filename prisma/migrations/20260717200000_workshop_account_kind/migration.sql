-- CreateEnum
CREATE TYPE "WorkshopAccountKind" AS ENUM ('PARENT', 'VISITEUR');

-- AlterTable
ALTER TABLE "WorkshopReservation" ADD COLUMN "accountKind" "WorkshopAccountKind" NOT NULL DEFAULT 'PARENT';

-- CreateIndex
CREATE INDEX "WorkshopReservation_accountKind_idx" ON "WorkshopReservation"("accountKind");
