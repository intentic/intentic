-- The shape columns arrive with the only shape that has ever existed as their fill: on the day this runs every
-- hosted machine is 4 shared vCPUs, 4 GB and a 10 GB volume, because the provisioner read one figure out of config
-- for all of them. The defaults are dropped again straight away, so from here the writer must say what it made.
ALTER TABLE "hosted_machine" ADD COLUMN "tier" TEXT NOT NULL DEFAULT 'free';
ALTER TABLE "hosted_machine" ADD COLUMN "cpuKind" TEXT NOT NULL DEFAULT 'shared';
ALTER TABLE "hosted_machine" ADD COLUMN "cpus" INTEGER NOT NULL DEFAULT 4;
ALTER TABLE "hosted_machine" ADD COLUMN "memoryMb" INTEGER NOT NULL DEFAULT 4096;
ALTER TABLE "hosted_machine" ADD COLUMN "volumeGb" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "hosted_machine" ALTER COLUMN "cpus" DROP DEFAULT;
ALTER TABLE "hosted_machine" ALTER COLUMN "memoryMb" DROP DEFAULT;
ALTER TABLE "hosted_machine" ALTER COLUMN "volumeGb" DROP DEFAULT;

-- AlterTable
ALTER TABLE "hosted_machine" ADD COLUMN "migratingId" TEXT;

-- The disk a trashed sandbox left behind is a particular size on a particular rung; nullable because a sandbox that
-- ran on its owner's own computer left no machine at all, and rows written before this knew nothing about rungs.
ALTER TABLE "sandbox_trash" ADD COLUMN "tier" TEXT;
ALTER TABLE "sandbox_trash" ADD COLUMN "cpuKind" TEXT;
ALTER TABLE "sandbox_trash" ADD COLUMN "cpus" INTEGER;
ALTER TABLE "sandbox_trash" ADD COLUMN "memoryMb" INTEGER;
ALTER TABLE "sandbox_trash" ADD COLUMN "volumeGb" INTEGER;

-- CreateTable
CREATE TABLE "hosted_migration" (
    "id" TEXT NOT NULL,
    "hostedMachineId" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fromTier" TEXT NOT NULL,
    "toTier" TEXT NOT NULL,
    "fromCpuKind" TEXT NOT NULL,
    "fromCpus" INTEGER NOT NULL,
    "fromMemoryMb" INTEGER NOT NULL,
    "fromVolumeGb" INTEGER NOT NULL,
    "toCpuKind" TEXT NOT NULL,
    "toCpus" INTEGER NOT NULL,
    "toMemoryMb" INTEGER NOT NULL,
    "toVolumeGb" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'planned',
    "snapshotId" TEXT,
    "oldMachineId" TEXT,
    "newMachineId" TEXT,
    "oldVolumeId" TEXT,
    "newVolumeId" TEXT,
    "requestedBy" TEXT NOT NULL,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "hosted_migration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hosted_migration_state_idx" ON "hosted_migration"("state");

-- CreateIndex
CREATE INDEX "hosted_migration_hostedMachineId_startedAt_idx" ON "hosted_migration"("hostedMachineId", "startedAt");

-- AddForeignKey
ALTER TABLE "hosted_migration" ADD CONSTRAINT "hosted_migration_hostedMachineId_fkey" FOREIGN KEY ("hostedMachineId") REFERENCES "hosted_machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The hour meter gains a machine, and keeps its account. The CEILING becomes the machine's rung's, so the row is
-- keyed by sandbox; the account's month still has to survive the sandbox that spent it, or releasing a machine and
-- asking for another would reset the free lane. On the day this runs an account holds one hosted machine, so this
-- month's minutes attach to it and an account with none keeps its row with a null sandbox, which is the same shape
-- a later release leaves behind.
ALTER TABLE "hosted_usage" RENAME COLUMN "userId" TO "ownerId";
ALTER TABLE "hosted_usage" RENAME CONSTRAINT "hosted_usage_userId_fkey" TO "hosted_usage_ownerId_fkey";
ALTER TABLE "hosted_usage" ADD COLUMN "sandboxId" TEXT;

UPDATE "hosted_usage" SET "sandboxId" = (
    SELECT "s"."id" FROM "sandbox" "s"
    JOIN "hosted_machine" "m" ON "m"."sandboxId" = "s"."id"
    WHERE "s"."ownerId" = "hosted_usage"."ownerId"
    ORDER BY "m"."createdAt" ASC
    LIMIT 1
);

-- A second machine on the same account would collide on the new key; the oldest one keeps the month, the rest are
-- left keyed by nothing and still count towards the account.
UPDATE "hosted_usage" "a" SET "sandboxId" = NULL
    FROM "hosted_usage" "b"
    WHERE "a"."sandboxId" = "b"."sandboxId" AND "a"."month" = "b"."month" AND "a"."id" > "b"."id";

DROP INDEX "hosted_usage_userId_month_key";
CREATE UNIQUE INDEX "hosted_usage_sandboxId_month_key" ON "hosted_usage"("sandboxId", "month");
CREATE INDEX "hosted_usage_ownerId_month_idx" ON "hosted_usage"("ownerId", "month");
ALTER TABLE "hosted_usage" ADD CONSTRAINT "hosted_usage_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "sandbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Slots move from one quantity on the plan to one row per rung, because the plan now sells more than one machine.
-- Every standing subscription was sold at the entry rung, so its item and quantity become that rung's row; the rung
-- is named here rather than read from the ladder, since a migration records a moment and the ladder moves.
CREATE TABLE "hosted_plan_item" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "stripeItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hosted_plan_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hosted_plan_item_stripeItemId_key" ON "hosted_plan_item"("stripeItemId");

-- CreateIndex
CREATE UNIQUE INDEX "hosted_plan_item_planId_tier_key" ON "hosted_plan_item"("planId", "tier");

-- AddForeignKey
ALTER TABLE "hosted_plan_item" ADD CONSTRAINT "hosted_plan_item_planId_fkey" FOREIGN KEY ("planId") REFERENCES "hosted_plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "hosted_plan_item" ("id", "planId", "tier", "stripeItemId", "quantity", "updatedAt")
SELECT "id" || '-standard', "id", 'standard', "stripeItemId", "quantity", CURRENT_TIMESTAMP
FROM "hosted_plan"
WHERE "stripeItemId" <> '';

ALTER TABLE "hosted_plan" DROP COLUMN "stripeItemId";
ALTER TABLE "hosted_plan" DROP COLUMN "quantity";

-- The provider reports a machine the kernel killed for memory on its exit event, and the hour meter already asks how
-- every stopped machine ended — so this is a row rather than a round trip. It is the reliability signal for a rung
-- sized too small, and the only honest thing to show somebody before offering them a bigger one.
CREATE TABLE "hosted_oom" (
    "id" TEXT NOT NULL,
    "hostedMachineId" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "memoryMb" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hosted_oom_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hosted_oom_sandboxId_at_idx" ON "hosted_oom"("sandboxId", "at");

-- CreateIndex
CREATE INDEX "hosted_oom_at_idx" ON "hosted_oom"("at");

-- AddForeignKey
ALTER TABLE "hosted_oom" ADD CONSTRAINT "hosted_oom_hostedMachineId_fkey" FOREIGN KEY ("hostedMachineId") REFERENCES "hosted_machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
