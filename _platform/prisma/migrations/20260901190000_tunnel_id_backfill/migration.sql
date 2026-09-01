-- WHAT THIS REPAIRS. 20260831120000_ingress_reachability added `tunnelId` as `TEXT NOT NULL` with no default
-- and no backfill, on the strength of a "fresh-state reshape (pre-launch, no users)" that was not true of the
-- one database it had to be true of. Postgres can run that statement against an EMPTY table only: every row it
-- finds needs a value the statement never supplies. So it applied cleanly to every database CI builds — all of
-- them empty — and stopped on production with
--
--     ERROR: column "tunnelId" of relation "sandbox" contains null values
--
-- Prisma rolled it back and recorded it as FAILED, which is a wall rather than a bad night: `migrate deploy`
-- then answers P3009 for every later migration too, so the api image's boot chain never got past its first
-- step and the platform served nothing at all. Every pipeline since pushed the same images at the same wall
-- and reported the deploy red for a reason the deploy could not see.
--
-- The failed migration is not edited — it is applied, and correct, on every database that was empty when it
-- arrived, and the history is append-only (check-migrations.sh). The reshape is completed FORWARD instead, in
-- the four steps that hold whether or not the table has rows:
--
--   1. drop `zrokToken`, which the failed migration would have dropped
--   2. add `tunnelId` NULLABLE, which any table accepts
--   3. fill it — nothing is invented here: `tunnelId` IS the first twelve hex of `tokenDigest` (the one
--      derivation every party shares, sandboxIdFromToken in tunnel-ids), so every existing row already
--      carries its own id and this only materializes it into the column that indexes it
--   4. and only then make it NOT NULL and unique, over a column that now has a value in every row
--
-- Every statement is guarded because this migration meets two different databases: production, where the
-- original never ran, and every fresh one, where it did. On a fresh database all four steps find their work
-- already done and change nothing — which is what keeps `migrate diff` empty on both, and what lets one
-- schema.prisma keep describing them both.
--
-- Production needs one thing no migration can do for itself: the failed row cleared, so `migrate deploy` is
-- willing to look at anything after it. That is `prisma migrate resolve --applied
-- 20260831120000_ingress_reachability` inside the api container — the runbook is in the prisma README. It
-- records the name as done; this migration is what then makes the name true, and the api's own boot-time
-- schema diff is what proves it before it serves a request.

-- AlterTable
ALTER TABLE "sandbox" DROP COLUMN IF EXISTS "zrokToken";
ALTER TABLE "sandbox" ADD COLUMN IF NOT EXISTS "tunnelId" TEXT;

-- Backfill
UPDATE "sandbox" SET "tunnelId" = substring("tokenDigest" FROM 1 FOR 12) WHERE "tunnelId" IS NULL;

-- AlterTable
ALTER TABLE "sandbox" ALTER COLUMN "tunnelId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_tunnelId_key" ON "sandbox"("tunnelId");
