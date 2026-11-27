-- Wake doors (2026-11-27): the public paths a request may wake a sleeping hosted sandbox at, each as the SHA-256 of the
-- secret the request carries, never the secret (api hosted-request-wake.ts). Saved by the daemon with the alarm it saves
-- before it sleeps, and cleared once its boot takes charge.
ALTER TABLE "sandbox" ADD COLUMN "wakeDoors" JSONB;
-- The request wake under way, and how many the UTC day `requestWakeDay` started, which bound a leaked door's cost.
ALTER TABLE "sandbox" ADD COLUMN "requestWakeAt" TIMESTAMP(3);
ALTER TABLE "sandbox" ADD COLUMN "requestWakeDay" TIMESTAMP(3);
ALTER TABLE "sandbox" ADD COLUMN "requestWakeCount" INTEGER NOT NULL DEFAULT 0;
