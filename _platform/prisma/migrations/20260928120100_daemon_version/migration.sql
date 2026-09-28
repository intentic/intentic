-- The version a sandbox's daemon names on its announce (api app.ts), kept so the platform knows what each sandbox runs.
-- Nullable: a daemon older than the field announces without it.
ALTER TABLE "sandbox" ADD COLUMN "daemonVersion" TEXT;
