-- The post-switch probation of a hosted machine's new image (api gate/hosted-probation.ts): when the gate saw it come
-- up, and how many looks in a row have found it failing since. Both start empty; no row is on probation until the
-- next image change that took.

-- AlterTable
ALTER TABLE "hosted_machine" ADD COLUMN "probationSince" TIMESTAMP(3);
ALTER TABLE "hosted_machine" ADD COLUMN "probationStrikes" INTEGER NOT NULL DEFAULT 0;
