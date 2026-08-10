-- The services economy on top of the creator pool: the catalog of priced upstreams (operator-created),
-- the per-day credit meter (trial_usage shape), and the run ledger provider earnings are computed from.

-- CreateTable
CREATE TABLE "service" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "publisher" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "upstreamUrl" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "creditsPerRun" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_spend" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_spend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_run" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_slug_key" ON "service"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "credit_spend_userId_day_key" ON "credit_spend"("userId", "day");

-- CreateIndex
CREATE INDEX "credit_spend_day_idx" ON "credit_spend"("day");

-- CreateIndex
CREATE INDEX "service_run_serviceId_createdAt_idx" ON "service_run"("serviceId", "createdAt");

-- CreateIndex
CREATE INDEX "service_run_userId_idx" ON "service_run"("userId");

-- CreateIndex
CREATE INDEX "service_run_createdAt_idx" ON "service_run"("createdAt");

-- AddForeignKey
ALTER TABLE "credit_spend" ADD CONSTRAINT "credit_spend_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_run" ADD CONSTRAINT "service_run_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_run" ADD CONSTRAINT "service_run_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
