-- CreateEnum
CREATE TYPE "AppModuleRole" AS ENUM ('INSCRIPTIONS', 'ELEVES', 'PARENTS', 'PROGRAMME', 'UTILISATEURS', 'FINANCE', 'DOCUMENTS', 'PARAMETRAGE');

-- CreateTable
CREATE TABLE "UserAppModuleRole" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "AppModuleRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserAppModuleRole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserAppModuleRole_userId_idx" ON "UserAppModuleRole"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserAppModuleRole_userId_role_key" ON "UserAppModuleRole"("userId", "role");

-- AddForeignKey
ALTER TABLE "UserAppModuleRole" ADD CONSTRAINT "UserAppModuleRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
