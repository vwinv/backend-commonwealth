-- CreateEnum
CREATE TYPE "ServiceBillingPeriod" AS ENUM ('MONTHLY', 'YEARLY');

-- AlterTable
ALTER TABLE "ServiceTariff" ADD COLUMN "amountCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "billingPeriod" "ServiceBillingPeriod" NOT NULL DEFAULT 'MONTHLY';
