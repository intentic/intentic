-- AlterTable
ALTER TABLE "hosted_cleanup" ADD COLUMN "deleteAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "sandbox_trash" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "image" TEXT,
    "appName" TEXT,
    "machineId" TEXT,
    "volumeId" TEXT,
    "region" TEXT,
    "flyImage" TEXT,
    "baseImage" TEXT,
    "environmentHash" TEXT,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purgeAfter" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sandbox_trash_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_trash_appName_key" ON "sandbox_trash"("appName");

-- CreateIndex
CREATE INDEX "sandbox_trash_ownerId_idx" ON "sandbox_trash"("ownerId");

-- CreateIndex
CREATE INDEX "sandbox_trash_purgeAfter_idx" ON "sandbox_trash"("purgeAfter");

-- AddForeignKey
ALTER TABLE "sandbox_trash" ADD CONSTRAINT "sandbox_trash_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
