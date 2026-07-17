-- AlterTable
ALTER TABLE "WorkshopReservation" ADD COLUMN "userId" TEXT;

-- CreateIndex
CREATE INDEX "WorkshopReservation_userId_idx" ON "WorkshopReservation"("userId");

-- AddForeignKey
ALTER TABLE "WorkshopReservation" ADD CONSTRAINT "WorkshopReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
