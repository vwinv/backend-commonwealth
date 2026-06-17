-- Horaires par niveau + options personnalisables

CREATE TYPE "OptionPricingMode" AS ENUM ('FLAT', 'CUSTOMIZABLE');

ALTER TABLE "ServiceTariff" ADD COLUMN "pricingMode" "OptionPricingMode" NOT NULL DEFAULT 'FLAT';

CREATE TABLE "ServiceOptionVariant" (
    "id" TEXT NOT NULL,
    "serviceTariffId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL DEFAULT 0,
    "billingPeriod" "ServiceBillingPeriod" NOT NULL DEFAULT 'MONTHLY',
    "order" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceOptionVariant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ServiceOptionVariant_serviceTariffId_code_key" ON "ServiceOptionVariant"("serviceTariffId", "code");
CREATE INDEX "ServiceOptionVariant_serviceTariffId_idx" ON "ServiceOptionVariant"("serviceTariffId");

ALTER TABLE "ServiceOptionVariant" ADD CONSTRAINT "ServiceOptionVariant_serviceTariffId_fkey" FOREIGN KEY ("serviceTariffId") REFERENCES "ServiceTariff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "LevelSchedule" (
    "id" TEXT NOT NULL,
    "schoolYear" TEXT NOT NULL,
    "levelId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "timeDescription" TEXT,
    "annualTuitionCents" INTEGER NOT NULL DEFAULT 0,
    "monthlyBaseCents" INTEGER NOT NULL DEFAULT 0,
    "order" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LevelSchedule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LevelSchedule_schoolYear_levelId_label_key" ON "LevelSchedule"("schoolYear", "levelId", "label");
CREATE INDEX "LevelSchedule_levelId_schoolYear_idx" ON "LevelSchedule"("levelId", "schoolYear");

ALTER TABLE "LevelSchedule" ADD CONSTRAINT "LevelSchedule_levelId_fkey" FOREIGN KEY ("levelId") REFERENCES "Level"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Enrollment" ADD COLUMN "scheduleId" TEXT;
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "LevelSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EnrollmentServiceSubscription" ADD COLUMN "variantId" TEXT;
ALTER TABLE "EnrollmentServiceSubscription" ADD CONSTRAINT "EnrollmentServiceSubscription_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ServiceOptionVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ServiceLevelPrice" ADD COLUMN "variantId" TEXT;
ALTER TABLE "ServiceLevelPrice" DROP CONSTRAINT IF EXISTS "ServiceLevelPrice_schoolYear_levelId_serviceTariffId_key";
CREATE UNIQUE INDEX "ServiceLevelPrice_schoolYear_levelId_serviceTariffId_variantId_key" ON "ServiceLevelPrice"("schoolYear", "levelId", "serviceTariffId", "variantId");
ALTER TABLE "ServiceLevelPrice" ADD CONSTRAINT "ServiceLevelPrice_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ServiceOptionVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
