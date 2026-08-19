-- The wanted list: one row per "the catalog had nothing for this", filed by an agent through its sandbox.
-- The owner column only bounds the writer (a daily cap); the public catalog reads the aggregate — normalized
-- text, distinct owners, newest ask — so unmet demand becomes a lead a provider can build against.

-- CreateTable
CREATE TABLE "service_want" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_want_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_want_normalized_createdAt_idx" ON "service_want"("normalized", "createdAt");

-- CreateIndex
CREATE INDEX "service_want_userId_createdAt_idx" ON "service_want"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "service_want_createdAt_idx" ON "service_want"("createdAt");

-- AddForeignKey
ALTER TABLE "service_want" ADD CONSTRAINT "service_want_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
