-- AlterTable
ALTER TABLE "ChildFollowUpNote" ADD COLUMN "rating" INTEGER;

-- AlterTable: allow empty explanatory note when rating is 5
ALTER TABLE "ChildFollowUpNote" ALTER COLUMN "content" SET DEFAULT '';
