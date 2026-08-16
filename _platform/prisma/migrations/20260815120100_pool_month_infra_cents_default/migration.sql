-- 20260813120000_hosted_hours added `pool_month.infraCents` with DEFAULT 0 so the column could be NOT NULL
-- over rows that already existed. schema.prisma declares it `Int` with no `@default`, so the backfill default
-- outlived the backfill and every database has carried a default the schema does not know about — the second
-- thing the new schema-parity check in CI found, and the reason it could not have been switched on as-is.
--
-- Dropped rather than written into the schema: the client always sends this value, so a database-side default
-- is only a way for a row to be written without one.
ALTER TABLE "pool_month" ALTER COLUMN "infraCents" DROP DEFAULT;
