-- When a sandbox's own machine last asked for wakes on it (api host-report.ts POST /host-report/wakes), stamped at most
-- once a minute: what tells a sandbox asleep on a machine that is up from one whose machine is off.

-- AlterTable
ALTER TABLE "sandbox" ADD COLUMN "sleepCheckedAt" TIMESTAMP(3);
