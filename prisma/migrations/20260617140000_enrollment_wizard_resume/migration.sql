-- Reprise du wizard d'inscription (brouillon serveur + lien e-mail)
ALTER TABLE "Enrollment" ADD COLUMN "wizardStep" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Enrollment" ADD COLUMN "wizardData" JSONB;
ALTER TABLE "Enrollment" ADD COLUMN "resumeToken" TEXT;

CREATE UNIQUE INDEX "Enrollment_resumeToken_key" ON "Enrollment"("resumeToken");
