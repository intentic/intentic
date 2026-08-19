-- The member's own USDC wallet and the signatures minted against it. One wallet per (account, network),
-- owner-scoped and never pooled: the key material is held by a custody provider (providerWalletId is the
-- handle), and the caps mirror the sandbox capability card's policy so the signer enforces what the owner
-- set rather than what a container claims. Amounts are USD decimal strings — the signer's arithmetic runs
-- in USDC's atomic units, and a float column in the money path would be a rounding bug.

-- CreateTable
CREATE TABLE "wallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "providerWalletId" TEXT NOT NULL,
    "perPaymentMaxUsd" TEXT NOT NULL DEFAULT '1.00',
    "dailyCapUsd" TEXT NOT NULL DEFAULT '5.00',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_payment" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "amountUsd" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "payTo" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_userId_network_key" ON "wallet"("userId", "network");

-- CreateIndex
CREATE INDEX "wallet_userId_idx" ON "wallet"("userId");

-- CreateIndex
CREATE INDEX "wallet_payment_walletId_day_idx" ON "wallet_payment"("walletId", "day");

-- CreateIndex
CREATE INDEX "wallet_payment_userId_createdAt_idx" ON "wallet_payment"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "wallet" ADD CONSTRAINT "wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_payment" ADD CONSTRAINT "wallet_payment_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
