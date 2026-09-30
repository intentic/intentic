-- What the machine a sandbox runs on found when the browser could not reach it (api host-report.ts). `ic sandbox fix`
-- posts it under a key derived from the connect token; the recovery panel's command first redeems a short-lived fix
-- code for that key. Nullable, no default: a sandbox has neither until someone asks.

-- AlterTable
ALTER TABLE "sandbox" ADD COLUMN "fixCode" TEXT,
ADD COLUMN "fixCodeExpiresAt" TIMESTAMP(3),
ADD COLUMN "hostReport" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_fixCode_key" ON "sandbox"("fixCode");
