-- RBAC for shared sandboxes: every invite now grants a trust tier. Existing members were invited under the
-- everything-goes model, which maps onto `collaborator` — the new default an owner can re-grade from the roster.

-- AlterTable
ALTER TABLE "sandbox_member" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'collaborator';
