-- The free hosted lane's hour meter. Two halves: the open end of an awake stretch on the machine itself
-- (the platform performs every wake, so it knows when running began), and a per-account monthly counter the
-- stretch is added to once Fly confirms the machine actually stopped.
--
-- Billed to the sandbox's OWNER, never to whoever woke it, so sharing a sandbox cannot launder machine time.

-- AlterTable. `idleWarnedAt` belongs to the sibling change that collects machines nobody has opened in weeks:
-- the stamp is what keeps one warning from becoming seven.
ALTER TABLE "hosted_machine" ADD COLUMN "wokeAt" TIMESTAMP(3);
ALTER TABLE "hosted_machine" ADD COLUMN "idleWarnedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "hosted_usage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hosted_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hosted_usage_userId_month_key" ON "hosted_usage"("userId", "month");

-- CreateIndex
CREATE INDEX "hosted_usage_month_idx" ON "hosted_usage"("month");

-- AddForeignKey
ALTER TABLE "hosted_usage" ADD CONSTRAINT "hosted_usage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The other half of the same change: what the platform's own infrastructure costs per member is now taken off
-- the top before the creator shares are computed, so a closed month has to record it beside the gross it came
-- out of. Distinct from feeCents, which is the payment processor's cut rather than ours.
ALTER TABLE "pool_month" ADD COLUMN "infraCents" INTEGER NOT NULL DEFAULT 0;
