-- Paying a closed month out. A payout is reserved before any money moves — the row and the claim on the
-- statements it covers are written in one transaction — and only then is the transfer attempted, keyed by this
-- row's own id. That ordering is what makes the run safe to retry: an interrupted payment is finished under the
-- same key rather than replaced by a second one. A statement's payoutId is therefore the only definition of
-- "already paid", and a failing transfer never gives it back.

-- CreateTable
CREATE TABLE "creator_payout" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stripeTransferId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "creator_payout_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "creator_statement" ADD COLUMN "payoutId" TEXT;

-- CreateIndex
CREATE INDEX "creator_payout_userId_idx" ON "creator_payout"("userId");

-- CreateIndex
CREATE INDEX "creator_payout_status_idx" ON "creator_payout"("status");

-- CreateIndex
CREATE INDEX "creator_statement_payoutId_idx" ON "creator_statement"("payoutId");

-- AddForeignKey
ALTER TABLE "creator_payout" ADD CONSTRAINT "creator_payout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_statement" ADD CONSTRAINT "creator_statement_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "creator_payout"("id") ON DELETE SET NULL ON UPDATE CASCADE;
