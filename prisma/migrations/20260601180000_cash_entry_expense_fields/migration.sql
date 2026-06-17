-- Entrée manuelle : champs formulaire
ALTER TABLE "CashManualEntry" ADD COLUMN IF NOT EXISTS "source" TEXT;
ALTER TABLE "CashManualEntry" ADD COLUMN IF NOT EXISTS "invoiceNumber" TEXT;
ALTER TABLE "CashManualEntry" ADD COLUMN IF NOT EXISTS "entryAt" TIMESTAMP(3);
UPDATE "CashManualEntry" SET "entryAt" = "createdAt" WHERE "entryAt" IS NULL;
ALTER TABLE "CashManualEntry" ALTER COLUMN "entryAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "CashManualEntry" ALTER COLUMN "entryAt" SET NOT NULL;

-- Sortie manuelle : date choisie
ALTER TABLE "CashExpense" ADD COLUMN IF NOT EXISTS "expenseAt" TIMESTAMP(3);
UPDATE "CashExpense" SET "expenseAt" = "createdAt" WHERE "expenseAt" IS NULL;
ALTER TABLE "CashExpense" ALTER COLUMN "expenseAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "CashExpense" ALTER COLUMN "expenseAt" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "CashManualEntry_entryAt_idx" ON "CashManualEntry"("entryAt");
CREATE INDEX IF NOT EXISTS "CashExpense_expenseAt_idx" ON "CashExpense"("expenseAt");
