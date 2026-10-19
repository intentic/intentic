import type { Logger } from "pino";
import type { AgentsRegistry } from "../registry/agents-registry.js";
import { type LandMarks, landMarksOf } from "../registry/land-marks.js";

// What a turn's close left when it skipped its land because the conversation would run again by itself (turn-close.ts
// step 4): the turn that wakes finishes the work and lands it. Kept so that when the wake goes away without firing (a
// person stops the job it waited on, or the watch), the land it skipped can run after all (wake-held-land.ts). Set or
// cleared by every turn whose body reaches its land; one that threw or was stopped leaves it, and the ending it leaves
// is what wake-held-land.ts refuses to land past. Kept on the conversation's record (registry/land-marks.ts), not in
// memory: a watch outlives a restart (watchers.ts restores it), so the land it held must too, or disarming the restored
// watch would land nothing and leave the work on its branch for a press (2026-10-19).

export type HeldLand = NonNullable<LandMarks["wakeHeld"]>;

interface Holders {
    readonly agents: Pick<AgentsRegistry, "amendLandMarks" | "entry">;
    readonly logger: Pick<Logger, "warn">;
}

/**
 * Records that the conversation's last close skipped its land for a wake, or, given undefined, that it did not. Never
 * throws: a write that fails costs only that later land, said in the log.
 */
export const noteLandHeldForWake = async ({ agents, logger }: Holders, conversationId: string, held: HeldLand | undefined): Promise<void> => {
    try {
        await agents.amendLandMarks(conversationId, (marks) => ({ ...marks, wakeHeld: held }));
    } catch (error) {
        logger.warn({ err: error, conversationId }, "agents: the land a wake holds could not be kept on the record");
    }
};

/** The land the conversation's last close skipped for a wake, taken: answered once, then forgotten. Never throws. */
export const takeLandHeldForWake = async ({ agents, logger }: Holders, conversationId: string): Promise<HeldLand | undefined> => {
    const held = landMarksOf(agents.entry(conversationId)).wakeHeld;
    if (held === undefined) {
        return undefined;
    }
    try {
        await agents.amendLandMarks(conversationId, (marks) => ({ ...marks, wakeHeld: undefined }));
        return held;
    } catch (error) {
        // Not landed on a mark that could not be taken: a land run now would run again at the next disarm.
        logger.warn({ err: error, conversationId }, "agents: the land a wake held could not be taken off the record, the work waits on its branch");
        return undefined;
    }
};
