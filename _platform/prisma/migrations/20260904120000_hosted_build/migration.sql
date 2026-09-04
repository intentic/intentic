-- The hosted lane's environment overlay builds (api hosted-build.ts). A hosted sandbox has no host to run
-- `ic sandbox rebuild` on, so the platform builds the owner-approved overlay on a builder machine in the
-- sandbox's own Fly app and boots the machine onto the result. The machine row remembers what it runs; the
-- build row is one build, from the builder's creation to its report.
--
-- Every new column on the existing table is nullable (check-migrations.sh, rule 2): a machine with no overlay
-- is the stock image, which is every machine that exists today.

-- AlterTable
ALTER TABLE "hosted_machine" ADD COLUMN "image" TEXT;
ALTER TABLE "hosted_machine" ADD COLUMN "baseImage" TEXT;
ALTER TABLE "hosted_machine" ADD COLUMN "environmentHash" TEXT;
ALTER TABLE "hosted_machine" ADD COLUMN "buildingId" TEXT;

-- CreateTable
CREATE TABLE "hosted_build" (
    "id" TEXT NOT NULL,
    "hostedMachineId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "baseImage" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "digest" TEXT,
    "builderMachineId" TEXT NOT NULL,
    "builderInstanceId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "tokenId" TEXT,
    "requestedBy" TEXT NOT NULL,
    "exitCode" INTEGER,
    "log" TEXT,
    "error" TEXT,
    "minutes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "hosted_build_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hosted_build_state_idx" ON "hosted_build"("state");

-- CreateIndex
CREATE INDEX "hosted_build_hostedMachineId_createdAt_idx" ON "hosted_build"("hostedMachineId", "createdAt");

-- AddForeignKey
ALTER TABLE "hosted_build" ADD CONSTRAINT "hosted_build_hostedMachineId_fkey" FOREIGN KEY ("hostedMachineId") REFERENCES "hosted_machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
