-- The donation model replaces usage telemetry for non-service extensions: sandboxes are self-hosted, so the
-- platform pays creators only on what passes through its own hands — a member's install-time credit donation,
-- deduped per (user, extension, month). The use-day ledger goes with the telemetry that fed it (fresh state,
-- no migration of rows: the pool had published no payouts yet).

-- DropTable
DROP TABLE "extension_use_day";

-- CreateTable
CREATE TABLE "donation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "donation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "donation_userId_extensionId_month_key" ON "donation"("userId", "extensionId", "month");

-- CreateIndex
CREATE INDEX "donation_month_idx" ON "donation"("month");

-- AddForeignKey
ALTER TABLE "donation" ADD CONSTRAINT "donation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
