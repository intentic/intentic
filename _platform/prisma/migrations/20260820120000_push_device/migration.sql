-- A native install registered with the push relay — one row per (account, device token). The row is the
-- relay's half of a channel whose other half lives on the owner's daemon: the daemon holds {deviceId, secret},
-- this row holds the APNs token and the secret's hash, and a send is the two halves meeting. The plaintext
-- secret exists only in the register response — a database read yields nothing that can send.

-- CreateTable
CREATE TABLE "push_device" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_device_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_device_userId_token_key" ON "push_device"("userId", "token");

-- CreateIndex
CREATE INDEX "push_device_userId_idx" ON "push_device"("userId");

-- AddForeignKey
ALTER TABLE "push_device" ADD CONSTRAINT "push_device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
