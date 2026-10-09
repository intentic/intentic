-- Repair's per-account daily turn meter (api repair-usage.ts, repair.routes.ts POST /api/repair/turn).
-- Counted per UTC day as YYYY-MM-DD; upsert on (userId, day). Swept by retention.ts with trial_usage rows.

-- CreateTable
CREATE TABLE "repair_usage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "turns" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repair_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "repair_usage_userId_day_key" ON "repair_usage"("userId", "day");

-- CreateIndex
CREATE INDEX "repair_usage_day_idx" ON "repair_usage"("day");

-- AddForeignKey
ALTER TABLE "repair_usage" ADD CONSTRAINT "repair_usage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
