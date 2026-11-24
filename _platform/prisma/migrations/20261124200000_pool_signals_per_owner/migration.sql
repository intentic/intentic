-- Shared run-outs become each owner's own (api pool-signals/, docs/architecture/account-routing.md). A row was keyed by
-- the account's fingerprint alone, a plain sha256 of the provider's ids, and read by anyone naming that fingerprint, so
-- the platform could tie together the Intentic accounts whose sandboxes held one provider seat. Now every row belongs
-- to the reporting sandbox's owner and is read only by that owner's other sandboxes, and the daemon makes the
-- fingerprint as an HMAC under a key minted once per owner (`provider_pool_key`), so one seat held by two owners is two
-- unrelated values.
--
-- The DELETE is not data loss: a signal is a run-out kept eight days at most and told again at the next refusal, and
-- every row on file is an unkeyed hash, which no daemon of this release asks for and which is the linkable value this
-- change exists to stop keeping. Emptying the table is also what lets `ownerId` be NOT NULL with no value to invent.
DELETE FROM "provider_pool_signal";

-- DropIndex
DROP INDEX "provider_pool_signal_fingerprint_pool_key";

-- AlterTable
ALTER TABLE "provider_pool_signal" ADD COLUMN "ownerId" TEXT;
ALTER TABLE "provider_pool_signal" ALTER COLUMN "ownerId" SET NOT NULL;

-- CreateTable
CREATE TABLE "provider_pool_key" (
    "ownerId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_pool_key_pkey" PRIMARY KEY ("ownerId")
);

-- CreateIndex
CREATE UNIQUE INDEX "provider_pool_signal_ownerId_fingerprint_pool_key" ON "provider_pool_signal"("ownerId", "fingerprint", "pool");

-- AddForeignKey
ALTER TABLE "provider_pool_signal" ADD CONSTRAINT "provider_pool_signal_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_pool_key" ADD CONSTRAINT "provider_pool_key_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
