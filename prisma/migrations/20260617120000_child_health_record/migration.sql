-- CreateEnum
CREATE TYPE "VaccinationStatus" AS ENUM ('DONE', 'MISSING');

-- CreateEnum
CREATE TYPE "SchoolSignatureType" AS ENUM ('CALLIGRAPHY', 'IMAGE');

-- CreateTable
CREATE TABLE "ChildHealthRecord" (
    "id" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "bloodGroup" TEXT,
    "doctorName" TEXT,
    "doctorPhone" TEXT,
    "knownAllergies" TEXT,
    "ongoingTreatments" TEXT,
    "dietaryRegime" TEXT,
    "instructions" TEXT,
    "schoolSignatureType" "SchoolSignatureType",
    "schoolSignatureText" TEXT,
    "schoolSignatureUrl" TEXT,
    "schoolSignedAt" TIMESTAMP(3),
    "schoolSignedById" TEXT,
    "parentSignatureUrl" TEXT,
    "parentSignedAt" TIMESTAMP(3),
    "parentSignatureRequestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChildHealthRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChildVaccination" (
    "id" TEXT NOT NULL,
    "healthRecordId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "VaccinationStatus" NOT NULL DEFAULT 'MISSING',
    "vaccinatedAt" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChildVaccination_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChildHealthRecord_childId_key" ON "ChildHealthRecord"("childId");

-- CreateIndex
CREATE INDEX "ChildVaccination_healthRecordId_idx" ON "ChildVaccination"("healthRecordId");

-- AddForeignKey
ALTER TABLE "ChildHealthRecord" ADD CONSTRAINT "ChildHealthRecord_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChildVaccination" ADD CONSTRAINT "ChildVaccination_healthRecordId_fkey" FOREIGN KEY ("healthRecordId") REFERENCES "ChildHealthRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
