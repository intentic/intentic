-- Closing a month: the frozen record payouts settle on. The public ledger recomputes itself live, which is
-- right while a month is open and impossible to pay against once it is over — and the donation/run rows it
-- computes from are swept at thirteen months, so without this the evidence of what was owed expires too.
-- Statements are per publisher, never per user: who a name belongs to is the claim table's answer and can
-- change after a close, so payability is derived rather than frozen into the row.

-- CreateTable
CREATE TABLE "pool_month" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "members" INTEGER NOT NULL,
    "grossCents" INTEGER NOT NULL,
    "feeCents" INTEGER NOT NULL,
    "poolCents" INTEGER NOT NULL,
    "earnedCents" INTEGER NOT NULL,
    "sweptCents" INTEGER NOT NULL,
    "distributedCents" INTEGER NOT NULL,
    "creatorShare" DOUBLE PRECISION NOT NULL,
    "serviceShare" DOUBLE PRECISION NOT NULL,
    "payableAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pool_month_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_statement" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "publisher" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "credits" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "expiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_statement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pool_month_month_key" ON "pool_month"("month");

-- CreateIndex
CREATE UNIQUE INDEX "creator_statement_month_publisher_key" ON "creator_statement"("month", "publisher");

-- CreateIndex
CREATE INDEX "creator_statement_publisher_idx" ON "creator_statement"("publisher");

-- AddForeignKey
ALTER TABLE "creator_statement" ADD CONSTRAINT "creator_statement_month_fkey" FOREIGN KEY ("month") REFERENCES "pool_month"("month") ON DELETE CASCADE ON UPDATE CASCADE;
