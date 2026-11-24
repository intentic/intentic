-- A sandbox's own colour (`#rrggbb`), set by its owner and shown to every member: the editor tints its rail, wallpaper
-- and composer with it, so two sandboxes open side by side are told apart at a glance. Every existing row keeps none,
-- which the editor reads as "derive one" (its preset logo's colour, else one from its id).

-- AlterTable
ALTER TABLE "sandbox" ADD COLUMN IF NOT EXISTS "color" TEXT;

-- A deleted sandbox keeps its colour beside its logo for the recovery window, so a restore brings both back.
ALTER TABLE "sandbox_trash" ADD COLUMN IF NOT EXISTS "color" TEXT;
