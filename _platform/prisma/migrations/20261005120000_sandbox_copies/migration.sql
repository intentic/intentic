-- Which copies of a sandbox are announcing, and which machine redeemed its setup code (api announce-copies.ts, app.ts).
-- One connect token held by two containers (the setup command pasted into PowerShell and into WSL) used to be accepted
-- twice, the last announce winning: the platform now keeps the last two distinct instances that announced, the moment
-- they were seen side by side, and the machine that claimed the current setup code first. Nullable, no default: a
-- sandbox has none of them until a daemon or an `ic` new enough to name itself says so.

-- AlterTable
ALTER TABLE "sandbox" ADD COLUMN "seenInstances" JSONB,
ADD COLUMN "duplicateSince" TIMESTAMP(3),
ADD COLUMN "setupClaimedBy" JSONB;
