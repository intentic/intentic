-- Sleep watches (2026-11-27): a connection a hosted sandbox's owner let the platform hold while it sleeps (a Discord
-- bot's token, encrypted with SECRETS_KEY), and where the messages addressed to it were while it slept, never their
-- words (api sandbox/hosted/sleep-watch/). Both go with their sandbox.

-- CreateTable
CREATE TABLE "sleep_watch" (
    "id" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "connection" TEXT NOT NULL,
    "credential" TEXT NOT NULL,
    "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "listenFrom" TIMESTAMP(3) NOT NULL,
    "wokeAt" TIMESTAMP(3),
    "retryAt" TIMESTAMP(3),
    "failures" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sleep_watch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sleep_heard" (
    "id" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "connection" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "guildId" TEXT,
    "heardAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sleep_heard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sleep_watch_sandboxId_connection_key" ON "sleep_watch"("sandboxId", "connection");

-- CreateIndex
CREATE INDEX "sleep_watch_listenFrom_idx" ON "sleep_watch"("listenFrom");

-- CreateIndex
CREATE UNIQUE INDEX "sleep_heard_sandboxId_connection_messageId_key" ON "sleep_heard"("sandboxId", "connection", "messageId");

-- CreateIndex
CREATE INDEX "sleep_heard_heardAt_idx" ON "sleep_heard"("heardAt");

-- AddForeignKey
ALTER TABLE "sleep_watch" ADD CONSTRAINT "sleep_watch_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "sandbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sleep_heard" ADD CONSTRAINT "sleep_heard_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "sandbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;
