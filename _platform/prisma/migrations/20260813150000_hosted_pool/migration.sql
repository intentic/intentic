-- The hosted lane's warm pool: machines built (and their image pulled) before anyone asks, sitting stopped
-- until a claim writes an identity into them and starts them. Turns the free sandbox's first wait from an
-- image pull into a machine start.

-- CreateTable
CREATE TABLE "hosted_pool_machine" (
    "id" TEXT NOT NULL,
    "appName" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "volumeId" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hosted_pool_machine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hosted_pool_machine_appName_key" ON "hosted_pool_machine"("appName");

-- CreateIndex
CREATE INDEX "hosted_pool_machine_region_state_idx" ON "hosted_pool_machine"("region", "state");
