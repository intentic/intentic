-- Open admission for paid services: a listing gains an owner, a lifecycle, and a probe log, so a provider can
-- list one by passing published gates instead of by asking an operator. The `active` boolean is replaced by
-- `status` — "live" stopped being one bit once draft and probation existed.

-- AlterTable
ALTER TABLE "service" DROP COLUMN "active";
ALTER TABLE "service" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'listed';
ALTER TABLE "service" ADD COLUMN "userId" TEXT;
ALTER TABLE "service" ADD COLUMN "probedAt" TIMESTAMP(3);
ALTER TABLE "service" ADD COLUMN "canaryFails" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "service" ADD COLUMN "suspendedFor" TEXT;
ALTER TABLE "service" ADD COLUMN "pricedAt" TIMESTAMP(3);
ALTER TABLE "service" ADD COLUMN "sampleRequest" TEXT NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "service_probe" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_probe_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_status_idx" ON "service"("status");

-- CreateIndex
CREATE INDEX "service_userId_idx" ON "service"("userId");

-- CreateIndex
CREATE INDEX "service_probe_serviceId_createdAt_idx" ON "service_probe"("serviceId", "createdAt");

-- CreateIndex
CREATE INDEX "service_probe_createdAt_idx" ON "service_probe"("createdAt");

-- AddForeignKey
ALTER TABLE "service" ADD CONSTRAINT "service_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_probe" ADD CONSTRAINT "service_probe_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
