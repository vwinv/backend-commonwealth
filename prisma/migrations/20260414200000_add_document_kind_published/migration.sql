-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('SCHOOL', 'ADMIN');

-- AlterTable
ALTER TABLE "Document" ADD COLUMN "kind" "DocumentKind" NOT NULL DEFAULT 'SCHOOL';

-- Existing rows remain visible to parents (comportement précédent)
ALTER TABLE "Document" ADD COLUMN "published" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Document" ALTER COLUMN "published" SET DEFAULT false;
