-- The creator pool: memberships (Stripe-mirrored) and the extension use-day ledger the revenue share is
-- computed from. Fresh tables — the old billing was dropped whole (20260806120000_drop_billing) and the pool
-- shares nothing with it.

-- CreateTable
CREATE TABLE "membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extension_use_day" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extension_use_day_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "membership_userId_key" ON "membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "membership_stripeCustomerId_key" ON "membership"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "membership_stripeSubscriptionId_key" ON "membership"("stripeSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "extension_use_day_userId_extensionId_day_key" ON "extension_use_day"("userId", "extensionId", "day");

-- CreateIndex
CREATE INDEX "extension_use_day_day_idx" ON "extension_use_day"("day");

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extension_use_day" ADD CONSTRAINT "extension_use_day_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
