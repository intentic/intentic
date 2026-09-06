-- The Billing page (docs/design/billing-view.md): the mirror learns what Stripe already knew about a
-- subscription beyond its status. cancelAtPeriodEnd is what the portal's cancel sets while status stays
-- active; quantity is how many hosted sandboxes the plan covers (one slot each); stripeItemId is what a
-- quantity write is addressed to; syncedAt is the Stripe event time that last wrote the row, the guard
-- against webhooks arriving out of order.
ALTER TABLE "hosted_plan" ADD COLUMN "stripeItemId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "hosted_plan" ADD COLUMN "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "hosted_plan" ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "hosted_plan" ADD COLUMN "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
