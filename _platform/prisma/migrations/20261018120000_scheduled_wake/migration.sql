ALTER TABLE "sandbox" ADD COLUMN "scheduledWakeAt" TIMESTAMP(3), ADD COLUMN "scheduledWakeRetryAt" TIMESTAMP(3);
CREATE INDEX "sandbox_scheduledWakeAt_idx" ON "sandbox"("scheduledWakeAt");
