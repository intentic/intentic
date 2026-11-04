-- The person's own look and reading preferences, kept with the account (api-contract account-preferences.ts): the
-- editor's preference names to the strings it stores for them, so every browser and device they sign in on shows them
-- the same. Every existing row keeps none, which reads as an empty set; each device's own choices stand until it offers
-- them.

-- AlterTable
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "preferences" JSONB;
