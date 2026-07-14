-- CreateEnum
CREATE TYPE "WorkshopReservationStatus" AS ENUM ('VALIDEE', 'EN_ATTENTE', 'ANNULEE');

-- CreateTable
CREATE TABLE "Workshop" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "importantInfo" TEXT,
    "imageUrl" TEXT NOT NULL,
    "eventDate" DATE NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "location" TEXT,
    "ageRange" TEXT,
    "recommendedAge" TEXT,
    "capacity" INTEGER NOT NULL,
    "isFree" BOOLEAN NOT NULL DEFAULT true,
    "priceLabel" TEXT,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workshop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkshopReservation" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "workshopId" TEXT NOT NULL,
    "childName" TEXT NOT NULL,
    "childAge" INTEGER,
    "parentName" TEXT NOT NULL,
    "parentPhone" TEXT,
    "places" INTEGER NOT NULL DEFAULT 1,
    "status" "WorkshopReservationStatus" NOT NULL DEFAULT 'EN_ATTENTE',
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkshopReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Workshop_eventDate_idx" ON "Workshop"("eventDate");

-- CreateIndex
CREATE INDEX "Workshop_published_idx" ON "Workshop"("published");

-- CreateIndex
CREATE UNIQUE INDEX "WorkshopReservation_code_key" ON "WorkshopReservation"("code");

-- CreateIndex
CREATE INDEX "WorkshopReservation_workshopId_idx" ON "WorkshopReservation"("workshopId");

-- CreateIndex
CREATE INDEX "WorkshopReservation_status_idx" ON "WorkshopReservation"("status");

-- CreateIndex
CREATE INDEX "WorkshopReservation_reservedAt_idx" ON "WorkshopReservation"("reservedAt");

-- AddForeignKey
ALTER TABLE "WorkshopReservation" ADD CONSTRAINT "WorkshopReservation_workshopId_fkey" FOREIGN KEY ("workshopId") REFERENCES "Workshop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
