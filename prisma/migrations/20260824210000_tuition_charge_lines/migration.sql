-- CreateEnum
CREATE TYPE "TuitionBillingLineKind" AS ENUM ('TUITION', 'MONTHLY_BASE', 'SERVICE', 'CREDIT');

-- CreateTable
CREATE TABLE "TuitionChargeLine" (
    "id" TEXT NOT NULL,
    "chargeId" TEXT NOT NULL,
    "kind" "TuitionBillingLineKind" NOT NULL,
    "serviceTariffId" TEXT,
    "label" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitAmountCents" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TuitionChargeLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TuitionChargeLine_chargeId_idx" ON "TuitionChargeLine"("chargeId");

-- AddForeignKey
ALTER TABLE "TuitionChargeLine" ADD CONSTRAINT "TuitionChargeLine_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "TuitionCharge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TuitionChargeLine" ADD CONSTRAINT "TuitionChargeLine_serviceTariffId_fkey" FOREIGN KEY ("serviceTariffId") REFERENCES "ServiceTariff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
