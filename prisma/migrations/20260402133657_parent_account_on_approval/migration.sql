-- AlterTable
ALTER TABLE "Child" ALTER COLUMN "parentId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Enrollment" ADD COLUMN     "pendingParentEmail" TEXT,
ADD COLUMN     "pendingParentFirstName" TEXT,
ADD COLUMN     "pendingParentLastName" TEXT,
ADD COLUMN     "pendingParentPhone" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "passwordHash" TEXT;
