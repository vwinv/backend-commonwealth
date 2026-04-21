-- CreateEnum
CREATE TYPE "MonthlyBillingLineKind" AS ENUM ('MONTHLY_BASE', 'SERVICE');

-- CreateTable
CREATE TABLE "ServiceTariff" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceTariff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LevelSchoolYearPricing" (
    "id" TEXT NOT NULL,
    "schoolYear" TEXT NOT NULL,
    "levelId" TEXT NOT NULL,
    "annualTuitionCents" INTEGER NOT NULL,
    "monthlyBaseCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LevelSchoolYearPricing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceLevelPrice" (
    "id" TEXT NOT NULL,
    "schoolYear" TEXT NOT NULL,
    "levelId" TEXT NOT NULL,
    "serviceTariffId" TEXT NOT NULL,
    "monthlyAmountCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceLevelPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnrollmentServiceSubscription" (
    "enrollmentId" TEXT NOT NULL,
    "serviceTariffId" TEXT NOT NULL,

    CONSTRAINT "EnrollmentServiceSubscription_pkey" PRIMARY KEY ("enrollmentId","serviceTariffId")
);

-- CreateTable
CREATE TABLE "TuitionCharge" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "schoolYear" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "transactionRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TuitionCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlyInstallment" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "totalAmountCents" INTEGER NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "transactionRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonthlyInstallment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlyInstallmentLine" (
    "id" TEXT NOT NULL,
    "installmentId" TEXT NOT NULL,
    "kind" "MonthlyBillingLineKind" NOT NULL,
    "serviceTariffId" TEXT,
    "label" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,

    CONSTRAINT "MonthlyInstallmentLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceTariff_code_key" ON "ServiceTariff"("code");

-- CreateIndex
CREATE INDEX "LevelSchoolYearPricing_levelId_idx" ON "LevelSchoolYearPricing"("levelId");

-- CreateIndex
CREATE UNIQUE INDEX "LevelSchoolYearPricing_schoolYear_levelId_key" ON "LevelSchoolYearPricing"("schoolYear", "levelId");

-- CreateIndex
CREATE INDEX "ServiceLevelPrice_levelId_idx" ON "ServiceLevelPrice"("levelId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceLevelPrice_schoolYear_levelId_serviceTariffId_key" ON "ServiceLevelPrice"("schoolYear", "levelId", "serviceTariffId");

-- CreateIndex
CREATE INDEX "TuitionCharge_enrollmentId_idx" ON "TuitionCharge"("enrollmentId");

-- CreateIndex
CREATE UNIQUE INDEX "TuitionCharge_enrollmentId_schoolYear_key" ON "TuitionCharge"("enrollmentId", "schoolYear");

-- CreateIndex
CREATE INDEX "MonthlyInstallment_enrollmentId_idx" ON "MonthlyInstallment"("enrollmentId");

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyInstallment_enrollmentId_year_month_key" ON "MonthlyInstallment"("enrollmentId", "year", "month");

-- CreateIndex
CREATE INDEX "MonthlyInstallmentLine_installmentId_idx" ON "MonthlyInstallmentLine"("installmentId");

-- AddForeignKey
ALTER TABLE "LevelSchoolYearPricing" ADD CONSTRAINT "LevelSchoolYearPricing_levelId_fkey" FOREIGN KEY ("levelId") REFERENCES "Level"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceLevelPrice" ADD CONSTRAINT "ServiceLevelPrice_levelId_fkey" FOREIGN KEY ("levelId") REFERENCES "Level"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceLevelPrice" ADD CONSTRAINT "ServiceLevelPrice_serviceTariffId_fkey" FOREIGN KEY ("serviceTariffId") REFERENCES "ServiceTariff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrollmentServiceSubscription" ADD CONSTRAINT "EnrollmentServiceSubscription_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrollmentServiceSubscription" ADD CONSTRAINT "EnrollmentServiceSubscription_serviceTariffId_fkey" FOREIGN KEY ("serviceTariffId") REFERENCES "ServiceTariff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TuitionCharge" ADD CONSTRAINT "TuitionCharge_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyInstallment" ADD CONSTRAINT "MonthlyInstallment_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyInstallmentLine" ADD CONSTRAINT "MonthlyInstallmentLine_installmentId_fkey" FOREIGN KEY ("installmentId") REFERENCES "MonthlyInstallment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyInstallmentLine" ADD CONSTRAINT "MonthlyInstallmentLine_serviceTariffId_fkey" FOREIGN KEY ("serviceTariffId") REFERENCES "ServiceTariff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
