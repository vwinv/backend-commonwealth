-- AlterTable
ALTER TABLE "CashExpense" ADD COLUMN "paymentMethod" TEXT,
ADD COLUMN "hasInvoice" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "CashManualEntry" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "paymentMethod" TEXT,
    "hasInvoice" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashManualEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CashManualEntry_sessionId_idx" ON "CashManualEntry"("sessionId");

-- AddForeignKey
ALTER TABLE "CashManualEntry" ADD CONSTRAINT "CashManualEntry_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CashSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
