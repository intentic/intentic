-- The column the desktop sign-in handoff has needed since it grew a PKCE-style verifier: `challenge` was added
-- to schema.prisma and to desktop.routes.ts, but the change was written INTO 20260802140000_desktop_handoff,
-- which every deployed database had already applied. Prisma keys _prisma_migrations by name, so an edited
-- migration never re-runs and `migrate deploy` reports "No pending migrations to apply" over a table that is
-- missing a column — which is how production served an unhandled 500 on every desktop sign-in while CI, whose
-- databases are always built fresh from the same edited file, stayed green. The column arrives here instead,
-- as its own forward step, which is the only way it can reach a database that has already run that migration.
--
-- IF NOT EXISTS because both shapes of database are real and both must land in the same place: production and
-- anything created before the edit (no column), against every developer and CI database created after it
-- (column already there, from the CREATE TABLE). It guards one DDL statement — no branching, no state carried
-- forward. 20260802140000 is deliberately left exactly as it is: editing it back would be the same mistake in
-- the other direction, and check-migrations.sh now refuses that edit for everyone from here on.
--
-- The DELETE is not data loss: a handoff row is a sign-in in flight, it expires three minutes after it is
-- written, and it is deleted by the first redeem. Emptying the table is what lets the column be NOT NULL with
-- no default, matching the schema, instead of inventing a placeholder challenge that no verifier can ever match.
DELETE FROM "desktop_handoff";

ALTER TABLE "desktop_handoff" ADD COLUMN IF NOT EXISTS "challenge" TEXT NOT NULL;
