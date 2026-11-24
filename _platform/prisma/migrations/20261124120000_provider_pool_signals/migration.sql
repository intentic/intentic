-- A provider account's pool that ran out in one sandbox, heard by the owner's other sandboxes on the same account (api
-- pool-signals/). The account is a hash only; the latest per account and pool, kept eight days.

-- CreateTable
CREATE TABLE "provider_pool_signal" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "pool" TEXT NOT NULL,
    "ranOutAt" TIMESTAMP(3) NOT NULL,
    "resetsAt" TIMESTAMP(3),
    "sandboxId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_pool_signal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "provider_pool_signal_fingerprint_pool_key" ON "provider_pool_signal"("fingerprint", "pool");

-- CreateIndex
CREATE INDEX "provider_pool_signal_sandboxId_idx" ON "provider_pool_signal"("sandboxId");

-- CreateIndex
CREATE INDEX "provider_pool_signal_updatedAt_idx" ON "provider_pool_signal"("updatedAt");

-- AddForeignKey
ALTER TABLE "provider_pool_signal" ADD CONSTRAINT "provider_pool_signal_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "sandbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;
