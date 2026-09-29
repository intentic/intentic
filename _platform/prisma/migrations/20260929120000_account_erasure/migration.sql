-- What an account leaves behind when it is deleted (api account-erase.ts). Two tables, neither joined to the user row,
-- since both must outlive it.
--
-- `hosted_standing`: the hosted suspension, the abuse watch's strike count and the month's used free hours, keyed by a
-- keyed hash of the Google account's subject rather than by the user, so deleting an account and signing in again with
-- the same Google account no longer starts clean. Expired by the retention sweep.
--
-- `stripe_erasure`: a deleted account's Stripe customer and subscription, written before the cascade takes the plan
-- row, until Stripe confirms the customer is deleted.
--
-- Both are new tables, so nothing here touches a row that exists.

-- CreateTable
CREATE TABLE "hosted_standing" (
    "subjectHash" TEXT NOT NULL,
    "suspendedAt" TIMESTAMP(3),
    "strikes" INTEGER NOT NULL DEFAULT 0,
    "standingAt" TIMESTAMP(3),
    "month" TEXT,
    "freeMinutes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hosted_standing_pkey" PRIMARY KEY ("subjectHash")
);

-- CreateTable
CREATE TABLE "stripe_erasure" (
    "customerId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stripe_erasure_pkey" PRIMARY KEY ("customerId")
);

-- CreateIndex
CREATE INDEX "hosted_standing_standingAt_idx" ON "hosted_standing"("standingAt");

-- CreateIndex
CREATE INDEX "hosted_standing_month_idx" ON "hosted_standing"("month");

