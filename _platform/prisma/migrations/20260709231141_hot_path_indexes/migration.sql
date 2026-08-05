-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE INDEX "sandbox_ownerId_idx" ON "sandbox"("ownerId");

-- CreateIndex
CREATE INDEX "sandbox_member_email_idx" ON "sandbox_member"("email");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE INDEX "subscription_referenceId_idx" ON "subscription"("referenceId");
