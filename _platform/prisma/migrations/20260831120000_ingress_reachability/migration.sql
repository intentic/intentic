-- Reachability stops being state. The zrok hub is gone: a sandbox is now reached through the platform's own
-- edge, which it dials outbound with a grant the platform SIGNS over the sandbox's 12-hex id, so there is no
-- account to mint upstream and no token to cache — `zrokToken` has nothing left to hold. Revoking reachability
-- is deleting the sandbox row, which the edge reads back over GET /api/reachability/<id>.
--
-- `tunnelId` is that id, materialized: the first twelve hex of `tokenDigest`, written once at creation. It is
-- indexed because the edge looks a sandbox UP by it on every tunnel registration, and a prefix query against
-- `tokenDigest` cannot use its index under a default collation. Unique because two sandboxes sharing the id
-- would serve each other's hostnames.
--
-- Fresh-state reshape (pre-launch, no users), like the migration that brought `zrokToken` in: the new column
-- is NOT NULL with no default and no backfill.

-- AlterTable
ALTER TABLE "sandbox" DROP COLUMN "zrokToken",
ADD COLUMN "tunnelId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_tunnelId_key" ON "sandbox"("tunnelId");
