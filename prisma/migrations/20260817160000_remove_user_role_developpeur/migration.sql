-- Convert leftover DEVELOPPEUR users, then drop the enum value.
UPDATE "User" SET role = 'ADMIN' WHERE role::text = 'DEVELOPPEUR';

CREATE TYPE "UserRole_new" AS ENUM ('PARENT', 'ADMIN', 'STAFF', 'VISITEUR');

ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "role" TYPE "UserRole_new" USING ("role"::text::"UserRole_new");

DROP TYPE "UserRole";
ALTER TYPE "UserRole_new" RENAME TO "UserRole";

ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'PARENT'::"UserRole";
