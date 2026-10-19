-- The free trial meters model calls, and a first small task could spend the whole day's allowance halfway through
-- (onboarding review 2026-10-18, F01). A turn the daemon opens while a step is left may now run past the allowance to
-- finish, up to the platform's `trial.graceSteps` a day: `graceOpen` counts such turns still running, `graceOpenedAt`
-- is when the latest one opened (an open never closed stops counting an hour later), `graceSteps` is today's spend.
--
-- Defaults make every existing row a day with no turn open and no grace spent, which is what they were.

-- AlterTable
ALTER TABLE "trial_usage" ADD COLUMN "graceOpen" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "graceOpenedAt" TIMESTAMP(3),
ADD COLUMN "graceSteps" INTEGER NOT NULL DEFAULT 0;
