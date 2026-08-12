-- Phase one of paying creators: who a publisher name belongs to, and where that person's money goes. The
-- pool could always compute what a listing earned; it had no way to name a payee. These two tables are that
-- join. No payout rows yet — moving money is the next layer and settles on a month the close has frozen.

-- CreateTable
CREATE TABLE "publisher_claim" (
    "id" TEXT NOT NULL,
    "publisher" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publisher_claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stripeAccountId" TEXT NOT NULL,
    "payoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "detailsSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "disabledReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_account_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "publisher_claim_publisher_key" ON "publisher_claim"("publisher");

-- CreateIndex
CREATE INDEX "publisher_claim_userId_idx" ON "publisher_claim"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "payout_account_userId_key" ON "payout_account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "payout_account_stripeAccountId_key" ON "payout_account"("stripeAccountId");

-- AddForeignKey
ALTER TABLE "publisher_claim" ADD CONSTRAINT "publisher_claim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_account" ADD CONSTRAINT "payout_account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
