-- CreateTable
CREATE TABLE "reserved_sandbox" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "tokenDigest" TEXT NOT NULL,
    "tunnelToken" TEXT NOT NULL,
    "tunnelHostname" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reserved_sandbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reserved_sandbox_token_key" ON "reserved_sandbox"("token");

-- CreateIndex
CREATE UNIQUE INDEX "reserved_sandbox_tokenDigest_key" ON "reserved_sandbox"("tokenDigest");
