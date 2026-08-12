-- The tunnel fabric moves in-house: reachability is a zrok account per sandbox (one encrypted token), not a
-- Cloudflare tunnel plus cached hostname. Fresh-state reshape (pre-launch, no users): the Cloudflare columns
-- and the pre-provisioned pool go, the account-token column arrives. The hostname needs no column — it stays
-- a stable digest of the connect token.

-- AlterTable
ALTER TABLE "sandbox" DROP COLUMN "tunnelToken",
DROP COLUMN "tunnelHostname",
ADD COLUMN "zrokToken" TEXT;

-- DropTable
DROP TABLE "reserved_sandbox";
