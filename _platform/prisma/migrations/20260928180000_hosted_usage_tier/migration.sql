-- Which hours paid for a minute becomes a recorded fact rather than an inference (api hosted-usage.ts): `free` for the
-- account's free hours, a paid rung's id for one machine's own month on the slot it stands on. The two used to be
-- told apart by reading the machine's rung at the moment of asking, which charged a machine that moved up a rung
-- with the free minutes it had spent before the move, and let a released free machine's minutes vanish from its
-- sandbox's month so a fresh machine started a fresh one.
ALTER TABLE "hosted_usage" ADD COLUMN "tier" TEXT NOT NULL DEFAULT 'free';

-- The rows already written were charged before anything recorded this, so they take the only evidence there is: a
-- machine standing on a paid rung today spent that rung's hours this month, and every other row (a free machine, a
-- released one) spent the account's free hours, which is what the default above already says.
UPDATE "hosted_usage" "u" SET "tier" = "m"."tier"
    FROM "hosted_machine" "m"
    WHERE "m"."sandboxId" = "u"."sandboxId" AND "m"."tier" <> 'free';

-- A machine's month is now one row per kind of hours it spent, so the key grows by the column.
DROP INDEX "hosted_usage_sandboxId_month_key";
CREATE UNIQUE INDEX "hosted_usage_sandboxId_month_tier_key" ON "hosted_usage"("sandboxId", "month", "tier");
