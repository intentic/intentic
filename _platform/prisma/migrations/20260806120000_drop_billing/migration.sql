-- Going fully free: there is no paid tier, so the platform stores no billing state at all.
-- The Better Auth Stripe plugin (the only writer of both) is gone.

-- DropTable
DROP TABLE "subscription";

-- AlterTable
ALTER TABLE "user" DROP COLUMN "stripeCustomerId";
