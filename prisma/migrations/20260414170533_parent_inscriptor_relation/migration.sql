-- CreateEnum
CREATE TYPE "ParentRelation" AS ENUM ('FATHER', 'MOTHER');

-- AlterTable
ALTER TABLE "Enrollment" ADD COLUMN     "pendingParentRelation" "ParentRelation";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "parentRelation" "ParentRelation";
