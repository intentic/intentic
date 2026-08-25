-- The admin panel's durable history, two pieces.
--
-- Sandbox.firstAnnouncedAt: the activation moment, written once on the first accepted announce and never
-- moved. lastSeenAt cannot answer "when did this sandbox come alive" (every check-in rewrites it), and both
-- time-to-activate and retention cohorts need the moment that does not move. Nullable, no backfill: a row
-- from before this column honestly says "unknown", which the panel states rather than invents.

-- AlterTable
ALTER TABLE "sandbox" ADD COLUMN "firstAnnouncedAt" TIMESTAMP(3);

-- One UTC day of platform history, written by the daily rollup so trend lines survive the retention sweeps
-- that take the raw rows. Counts only — no ids, no emails — so retention never sweeps this table.

-- CreateTable
CREATE TABLE "admin_daily_stat" (
    "id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "newUsers" INTEGER NOT NULL,
    "serviceRuns" INTEGER NOT NULL,
    "trialMessages" INTEGER NOT NULL,
    "totalUsers" INTEGER NOT NULL,
    "connectedUsers" INTEGER NOT NULL,
    "activeSandboxes24h" INTEGER NOT NULL,
    "membershipsActive" INTEGER NOT NULL,
    "hostedMachines" INTEGER NOT NULL,
    "digestAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_daily_stat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_daily_stat_day_key" ON "admin_daily_stat"("day");
