-- CreateTable
CREATE TABLE "trial_usage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "messages" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trial_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trial_usage_userId_day_key" ON "trial_usage"("userId", "day");

-- CreateIndex
CREATE INDEX "trial_usage_day_idx" ON "trial_usage"("day");

-- AddForeignKey
ALTER TABLE "trial_usage" ADD CONSTRAINT "trial_usage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
