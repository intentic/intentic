-- The desktop app now asks every few seconds, while its sign-in waits, whether the browser parked a hand-off for its
-- attempt (desktop.routes.ts `pending`), looked up by challenge.
CREATE INDEX IF NOT EXISTS "desktop_handoff_challenge_idx" ON "desktop_handoff"("challenge");
