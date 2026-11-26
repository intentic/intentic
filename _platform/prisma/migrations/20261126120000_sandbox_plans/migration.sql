-- Every cloud sandbox has a plan (api plan/plan-change.ts). A machine row now says whether its plan is paid for
-- (`paid`), and holds a plan change waiting to be applied (`planTo` at `planAt`), so a purchase lands on the sandbox it
-- was for instead of on an account-wide slot count a machine then has to be moved onto.
ALTER TABLE "hosted_machine" ADD COLUMN "paid" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "hosted_machine" ADD COLUMN "planTo" TEXT;
ALTER TABLE "hosted_machine" ADD COLUMN "planAt" TIMESTAMP(3);

-- The machines that hold a paid slot today keep it, by the rule the hour meter read until now (slotHolders): at each
-- paid rung of a live plan, the owner's oldest machines there, as many as the slots held at it. A slot nobody stands on
-- stays on the subscription as an open plan, which Billing asks the owner to put on a sandbox or end.
UPDATE "hosted_machine" AS m
SET "paid" = true
FROM (
    SELECT ranked."id"
    FROM (
        SELECT hm."id", hm."tier", s."ownerId",
               row_number() OVER (PARTITION BY s."ownerId", hm."tier" ORDER BY hm."createdAt", hm."id") AS "rank"
        FROM "hosted_machine" hm
        JOIN "sandbox" s ON s."id" = hm."sandboxId"
        WHERE hm."tier" <> 'free'
    ) ranked
    JOIN "hosted_plan" p ON p."userId" = ranked."ownerId" AND p."status" IN ('active', 'trialing')
    JOIN "hosted_plan_item" i ON i."planId" = p."id" AND i."tier" = ranked."tier"
    WHERE ranked."rank" <= i."quantity"
) AS holders
WHERE m."id" = holders."id";

-- The plan-change job looks for due changes.
CREATE INDEX "hosted_machine_planAt_idx" ON "hosted_machine"("planAt");
