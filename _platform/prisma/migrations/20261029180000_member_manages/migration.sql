-- The parts of the sandbox a member runs besides their own work, mirrored from the daemon's `manages` on the member row
-- (sandbox-contract ManageRightSchema). What the api reads to let someone other than the owner manage invites: Full
-- access, or the `people` right here. Every existing row names none, which is the default.

-- AlterTable
ALTER TABLE "sandbox_member" ADD COLUMN "manages" TEXT[] DEFAULT ARRAY[]::TEXT[];
