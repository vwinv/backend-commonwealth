-- AlterEnum
ALTER TYPE "AppModuleRole" ADD VALUE 'LANDING';

-- CreateTable
CREATE TABLE "LandingPage" (
    "id" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LandingPage_pkey" PRIMARY KEY ("id")
);
