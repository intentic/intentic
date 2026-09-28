-- What the hosted image gate remembers about a machine's versions (api gate/state-gate.ts): the image it ran before
-- its last image change and the overlay recipe that image carried, which the owner's rollback returns to; an image
-- applied without its daemon being seen to come up, whose next start is judged; and the platform digest the owner
-- rolled back from, which a restart does not re-apply while `:stable` still resolves to it.
--
-- And the digest an overlay's base resolved to when it was built (api hosted-build.ts), on the build, the machine and
-- the trash row that brings a machine back: a moving tag names a new base without its string changing.
--
-- Every column is nullable (check-migrations.sh, rule 2): no machine has an earlier image kept or anything on trial
-- yet, and no overlay built so far recorded its base's digest.
ALTER TABLE "hosted_machine" ADD COLUMN "previousImage" TEXT;
ALTER TABLE "hosted_machine" ADD COLUMN "previousEnvironmentHash" TEXT;
ALTER TABLE "hosted_machine" ADD COLUMN "unprovenImage" TEXT;
ALTER TABLE "hosted_machine" ADD COLUMN "skippedDigest" TEXT;
ALTER TABLE "hosted_machine" ADD COLUMN "baseDigest" TEXT;
ALTER TABLE "hosted_build" ADD COLUMN "baseDigest" TEXT;
ALTER TABLE "sandbox_trash" ADD COLUMN "baseDigest" TEXT;
