-- Which of an owner's sandboxes answers for a project (api projects/): the directory behind account-level report
-- routing. One sandbox per project per account; a claim goes with its sandbox and with its owner.

-- CreateTable
CREATE TABLE "project_claim" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "project" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_claim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_claim_ownerId_project_key" ON "project_claim"("ownerId", "project");

-- CreateIndex
CREATE INDEX "project_claim_sandboxId_idx" ON "project_claim"("sandboxId");

-- AddForeignKey
ALTER TABLE "project_claim" ADD CONSTRAINT "project_claim_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_claim" ADD CONSTRAINT "project_claim_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "sandbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;
