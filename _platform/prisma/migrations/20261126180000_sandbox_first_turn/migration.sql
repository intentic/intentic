-- When the first turn a person started on a sandbox finished without failing, as its daemon records it and sends on an
-- announce: the activation moment the operator's funnel counts (api admin-funnel.ts). Every existing row keeps none
-- until its daemon, on a release that records it, finishes such a turn and announces.

-- AlterTable
ALTER TABLE "sandbox" ADD COLUMN IF NOT EXISTS "firstTurnAt" TIMESTAMP(3);
