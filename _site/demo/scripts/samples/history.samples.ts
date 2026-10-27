import type { GroupSamples } from "./context.ts";
import { checkpointId } from "../../src/daemon/git/gitSha.ts";

// The history area's inputs: the timeline, the recording's second point (the checkout turn's work) and one file across
// it, then a restore to its third, which holds every file the tree already holds.
export const historySamples: GroupSamples<`history`> = () => ({
    list: undefined,
    diff: { id: checkpointId(2) },
    fileDiff: { id: checkpointId(2), scope: `web`, path: `src/lib/checkout.ts` },
    restore: { id: checkpointId(3) },
});
