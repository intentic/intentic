-- The credit economy goes and the membership becomes the hosted plan (docs/design/pricing-model.md). The one
-- thing the platform sells is a hosted sandbox that is always on; premium extensions, paid services, the
-- creator pool and the MCP services plane are removed with their tables. The membership table is RENAMED
-- rather than dropped: a subscription that used to mean "member" now means "on the hosted plan", and Stripe
-- is still its source of truth. Every index and constraint is renamed with it so a replay of this history
-- matches schema.prisma name for name (check-migrations.sh, rule 3).

-- DropTable: the MCP plane's OAuth authorization server (Better Auth `mcp` plugin) and the spend gate.
DROP TABLE "service_offer" CASCADE;
DROP TABLE "oauth_consent" CASCADE;
DROP TABLE "oauth_access_token" CASCADE;
DROP TABLE "oauth_application" CASCADE;

-- DropTable: the credit economy's ledgers, catalog and demand notes.
DROP TABLE "service_want" CASCADE;
DROP TABLE "service_run" CASCADE;
DROP TABLE "service_probe" CASCADE;
DROP TABLE "credit_spend" CASCADE;
DROP TABLE "donation" CASCADE;
DROP TABLE "service" CASCADE;

-- DropTable: the creator side, payouts, statements, claims and the frozen months.
DROP TABLE "creator_payout" CASCADE;
DROP TABLE "creator_statement" CASCADE;
DROP TABLE "pool_month" CASCADE;
DROP TABLE "payout_account" CASCADE;
DROP TABLE "publisher_claim" CASCADE;

-- RenameTable: membership → hosted_plan, constraints and indexes following.
ALTER TABLE "membership" RENAME TO "hosted_plan";
ALTER TABLE "hosted_plan" RENAME CONSTRAINT "membership_pkey" TO "hosted_plan_pkey";
ALTER TABLE "hosted_plan" RENAME CONSTRAINT "membership_userId_fkey" TO "hosted_plan_userId_fkey";
ALTER INDEX "membership_userId_key" RENAME TO "hosted_plan_userId_key";
ALTER INDEX "membership_stripeCustomerId_key" RENAME TO "hosted_plan_stripeCustomerId_key";
ALTER INDEX "membership_stripeSubscriptionId_key" RENAME TO "hosted_plan_stripeSubscriptionId_key";

-- AlterTable: the daily rollup loses its service-run window and counts plans rather than memberships.
ALTER TABLE "admin_daily_stat" DROP COLUMN "serviceRuns";
ALTER TABLE "admin_daily_stat" RENAME COLUMN "membershipsActive" TO "plansActive";
