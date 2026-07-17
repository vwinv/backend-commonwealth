-- CreateTable (éviter le conflit avec l'ENUM "ProgramCategory")
CREATE TABLE "ProgrammeCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#216EC2',
    "bgColor" TEXT NOT NULL DEFAULT '#E8F1FB',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgrammeCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProgrammeCategory_name_key" ON "ProgrammeCategory"("name");
CREATE UNIQUE INDEX "ProgrammeCategory_slug_key" ON "ProgrammeCategory"("slug");
CREATE INDEX "ProgrammeCategory_sortOrder_idx" ON "ProgrammeCategory"("sortOrder");
CREATE INDEX "ProgrammeCategory_active_idx" ON "ProgrammeCategory"("active");

INSERT INTO "ProgrammeCategory" ("id", "name", "slug", "color", "bgColor", "sortOrder", "active", "createdAt", "updatedAt") VALUES
  ('cat-sortie-scolaire', 'Sortie scolaire', 'SORTIE_SCOLAIRE', '#43A047', '#E8F5E9', 1, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cat-parents', 'Parents', 'PARENTS', '#F9994B', '#FFF3E0', 2, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cat-professeurs', 'Professeurs', 'PROFESSEURS', '#7E57C2', '#EDE7F6', 3, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cat-skills-eveil', 'Skills & éveil', 'SKILLS_EVEIL', '#AB47BC', '#F3E5F5', 4, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

ALTER TABLE "ProgramEvent" ADD COLUMN "categoryId" TEXT;

UPDATE "ProgramEvent" pe
SET "categoryId" = CASE pe."category"::text
  WHEN 'SORTIE_SCOLAIRE' THEN 'cat-sortie-scolaire'
  WHEN 'PARENTS' THEN 'cat-parents'
  WHEN 'PROFESSEURS' THEN 'cat-professeurs'
  WHEN 'SKILLS_EVEIL' THEN 'cat-skills-eveil'
  ELSE 'cat-sortie-scolaire'
END;

ALTER TABLE "ProgramEvent" ALTER COLUMN "categoryId" SET NOT NULL;

DROP INDEX IF EXISTS "ProgramEvent_category_idx";
ALTER TABLE "ProgramEvent" DROP COLUMN "category";
DROP TYPE "ProgramCategory";

CREATE INDEX "ProgramEvent_categoryId_idx" ON "ProgramEvent"("categoryId");

ALTER TABLE "ProgramEvent" ADD CONSTRAINT "ProgramEvent_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "ProgrammeCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
