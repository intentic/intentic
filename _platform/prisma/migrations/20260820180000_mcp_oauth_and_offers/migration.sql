-- Two things, one door: letting somebody who owns no sandbox buy a membership and spend it.
--
-- The three oauth_* tables make this platform an OAuth 2.1 authorization server (Better Auth's `mcp` plugin
-- owns them). A Claude Code install discovers the metadata, registers itself, and carries a bearer that names
-- a USER and no sandbox — the second principal class, which is what every metered route needed before a
-- person without a machine could pay for or run anything.
--
-- service_offer is the spend gate, written down. In a sandbox the gate is a card in a live conversation and a
-- held connection; off-sandbox there is neither, so the offer becomes a row whose `status` only the owner's
-- own browser session can move to 'approved'. The MCP client's answer is never read as consent — the run
-- re-reads this row — and 'approved' → 'spent' is conditional, so one approval releases exactly one run.

-- CreateTable
CREATE TABLE "oauth_application" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "metadata" TEXT,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT,
    "redirectUrls" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_access_token" (
    "id" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "accessTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "refreshTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT,
    "scopes" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_access_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_consent" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "consentGiven" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_offer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "request" TEXT NOT NULL,
    "why" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "service_offer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_application_clientId_key" ON "oauth_application"("clientId");

-- CreateIndex
CREATE INDEX "oauth_application_userId_idx" ON "oauth_application"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_access_token_accessToken_key" ON "oauth_access_token"("accessToken");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_access_token_refreshToken_key" ON "oauth_access_token"("refreshToken");

-- CreateIndex
CREATE INDEX "oauth_access_token_clientId_idx" ON "oauth_access_token"("clientId");

-- CreateIndex
CREATE INDEX "oauth_access_token_userId_idx" ON "oauth_access_token"("userId");

-- CreateIndex
CREATE INDEX "oauth_consent_clientId_idx" ON "oauth_consent"("clientId");

-- CreateIndex
CREATE INDEX "oauth_consent_userId_idx" ON "oauth_consent"("userId");

-- CreateIndex
CREATE INDEX "service_offer_userId_createdAt_idx" ON "service_offer"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "service_offer_expiresAt_idx" ON "service_offer"("expiresAt");

-- AddForeignKey
ALTER TABLE "oauth_application" ADD CONSTRAINT "oauth_application_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "oauth_application"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "oauth_application"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_offer" ADD CONSTRAINT "service_offer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_offer" ADD CONSTRAINT "service_offer_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
