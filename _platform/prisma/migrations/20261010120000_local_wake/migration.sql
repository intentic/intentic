-- Wake requests for sandboxes asleep on their own machine (api sandbox.routes.ts wake, host-report.ts POST
-- /host-report/wakes): set when somebody opens one, cleared once that machine's keeper has heard it.

-- AlterTable
ALTER TABLE "sandbox" ADD COLUMN "wakeRequestedAt" TIMESTAMP(3);
