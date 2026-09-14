-- The hosted free lane's abuse defences (docs/design/hosted-abuse.md): an account's hosted standing, the
-- ledger of who was handed a machine from where (the same-source caps), and the abuse watch's verdicts.
--
-- Both new columns are nullable (check-migrations.sh, rule 2): an account with nothing written here is in good
-- standing, which is every account that exists today.

-- AlterTable
ALTER TABLE "user" ADD COLUMN "hostedSuspendedAt" TIMESTAMP(3);
ALTER TABLE "user" ADD COLUMN "hostedSuspendedReason" TEXT;

-- CreateTable
CREATE TABLE "hosted_provision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "appName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hosted_provision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hosted_strike" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "appName" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "measure" DOUBLE PRECISION NOT NULL,
    "windowMinutes" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hosted_strike_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hosted_provision_ip_createdAt_idx" ON "hosted_provision"("ip", "createdAt");

-- CreateIndex
CREATE INDEX "hosted_provision_domain_createdAt_idx" ON "hosted_provision"("domain", "createdAt");

-- CreateIndex
CREATE INDEX "hosted_provision_createdAt_idx" ON "hosted_provision"("createdAt");

-- CreateIndex
CREATE INDEX "hosted_strike_userId_createdAt_idx" ON "hosted_strike"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "hosted_strike_createdAt_idx" ON "hosted_strike"("createdAt");

-- AddForeignKey
ALTER TABLE "hosted_provision" ADD CONSTRAINT "hosted_provision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_strike" ADD CONSTRAINT "hosted_strike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
