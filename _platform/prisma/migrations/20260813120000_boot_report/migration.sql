-- The setup wait learns to say what is actually happening. Two facts it had no room for: the daemon's own
-- verdict on whether this sandbox's PUBLIC address answers (it checks from the inside and posts it — the one
-- link nothing else can observe), and the host of a check-in we turned away for announcing an address we do
-- not expect. The second existed only as a server log, which is what made a mis-addressed sandbox look
-- exactly like one that never started.

-- AlterTable
ALTER TABLE "sandbox" ADD COLUMN "bootReport" JSONB,
ADD COLUMN "announceRefusal" JSONB;
