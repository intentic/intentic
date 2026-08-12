-- The hosted lane's machine record: for a sandbox the platform runs on Fly, the way back in (start on wake,
-- stop, destroy on delete). One per sandbox, cascades with it; the reaper destroys any Fly app under our
-- prefix whose row here is gone.

-- CreateTable
CREATE TABLE "hosted_machine" (
    "id" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "appName" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "volumeId" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hosted_machine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hosted_machine_sandboxId_key" ON "hosted_machine"("sandboxId");

-- CreateIndex
CREATE UNIQUE INDEX "hosted_machine_appName_key" ON "hosted_machine"("appName");

-- AddForeignKey
ALTER TABLE "hosted_machine" ADD CONSTRAINT "hosted_machine_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "sandbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;
