-- The bring-your-own-cloud lane is gone. It created ONE VM in the user's own Hetzner, DigitalOcean or Oracle
-- account off a pasted API token, and this column was its only residue: display metadata (provider, server
-- name, location) about a machine the platform could never reach again, because the credential that made it
-- was request-scoped by design.
--
-- Dropped rather than kept as history, because it is not history anybody can act on: the machines it names
-- live in accounts we have no way back into, so a row here can neither be started, stopped nor billed, and
-- the two screens that read it (the switcher badge, the delete dialog's "remove it in your provider's
-- console" warning) are gone with the lane.
--
-- Fresh-state reshape (pre-launch, no users), like the ingress migration before it: no backfill, no
-- compatibility read.

-- AlterTable
ALTER TABLE "sandbox" DROP COLUMN "cloud";
