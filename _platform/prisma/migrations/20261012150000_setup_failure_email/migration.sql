-- The one email a failed setup run sends its owner once nobody has been watching it for ten minutes (api
-- setup-failure-email.ts): when it went, and which failure it was for, so the same failure is never mailed twice.
-- Nullable, no default: nothing has been mailed until the sweep mails it.

-- AlterTable
ALTER TABLE "sandbox" ADD COLUMN "setupFailureEmailedAt" TIMESTAMP(3),
ADD COLUMN "setupFailureEmailedFor" TEXT;
