import type { IntenticLine } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/client";
import { acquireStreamSlot } from "../features/sandbox/client/streamBudget";

// Reads a daemon stream of IntenticLine frames (`intentic.run` and its kin) as they arrive; a failure the daemon reports
// mid-stream becomes one last kind:"error" line, so callers stop on it rather than on a throw. One connection-pool
// permit per read, since these can hold a socket for minutes; released in the generator's `finally`, even on early break.
export async function* readIntenticLines(frames: AsyncIterable<IntenticLine>): AsyncGenerator<IntenticLine> {
    const slot = await acquireStreamSlot(`attach`);
    try {
        for await (const line of frames) {
            if (typeof line === `object` && line !== null) {
                yield line;
            }
        }
    } catch (error) {
        if (!(error instanceof ORPCError)) {
            throw error;
        }
        yield { kind: `error`, message: error.message };
    } finally {
        slot?.();
    }
}
