-- Organisations (docs/architecture/organisations.md): an organisation, its people, and which sandboxes its policy holds.
-- Every existing sandbox stays personal: orgId starts null and only an admin binding one sets it.
-- AlterTable
ALTER TABLE "sandbox" ADD COLUMN     "orgId" TEXT,
ADD COLUMN     "orgPolicyApplied" INTEGER;

-- CreateTable
CREATE TABLE "organisation" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "policy" JSONB NOT NULL DEFAULT '{}',
    "policyVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organisation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_member" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_member_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "org_member_email_idx" ON "org_member"("email");

-- CreateIndex
CREATE UNIQUE INDEX "org_member_orgId_email_key" ON "org_member"("orgId", "email");

-- CreateIndex
CREATE INDEX "sandbox_orgId_idx" ON "sandbox"("orgId");

-- AddForeignKey
ALTER TABLE "sandbox" ADD CONSTRAINT "sandbox_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_member" ADD CONSTRAINT "org_member_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

