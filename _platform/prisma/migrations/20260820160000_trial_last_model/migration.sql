-- The free trial publishes one synthetic model id and picks the real model per message, so the id a user
-- selected no longer names what answered them. This column is where that fact is kept: the model the account's
-- most recent trial message actually ran on, written after the upstream answers and read back by the daemon on
-- its /trial/status poll so the turn can name it.
--
-- Nullable and unbacked by any default: a row written before this column existed, and a row whose message no
-- key ever served, both correctly say nothing.

-- AlterTable
ALTER TABLE "trial_usage" ADD COLUMN "lastModel" TEXT;
