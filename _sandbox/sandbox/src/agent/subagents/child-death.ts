import type { Services } from "../../composition.js";
import type { MemoryKill } from "../../system/resources/memory-records.js";
import { CHILDREN } from "./child-records.js";

// A child whose runtime was killed under it, told apart from one that failed at its own work: by memory when the OOM
// killer moved during its turn or the budget's sampler saw the box short in the last few minutes (earlyoom and the host's
// killer never move the counter), by
// something else outside it otherwise. Both leave its session intact, which is what the parent most needs to hear.
// The same reading decides whether any conversation's dead runtime is held as a memory kill (classify-failure.ts
// dressDeath), with what netd recorded as it killed (memory-kill.ts) beside it.

export type KillCause = "memory" | "outside";

// The SDK's own sentences for a runtime that died by signal; 137 and 143 are SIGKILL and SIGTERM through a shell.
const KILLED = /exited with code (?:137|143)\b|terminated by signal SIG(?:KILL|TERM)\b/u;

/** Whether a failure is the child's runtime being killed rather than the child failing. */
export const runtimeKilled = (failure: string): boolean => KILLED.test(failure);

// What the resource budget saw around the death: the OOM count now, and whether any recent reading was short.
export interface DeathWitness {
    readonly oomKills: number | undefined;
    readonly shortRecently: boolean;
}

/** Why a killed runtime died, from the OOM count at its turn's start and what the budget saw since. */
export const killCauseOf = (after: DeathWitness, oomKillsBefore: number | undefined): KillCause => {
    const killerMoved = oomKillsBefore !== undefined && after.oomKills !== undefined && after.oomKills > oomKillsBefore;
    return killerMoved || after.shortRecently ? "memory" : "outside";
};

/**
 * Why a conversation's killed runtime died, by what the budget saw: the OOM count against the one taken when a spawned
 * child's turn started (children.ts; no other conversation takes one, so only the sampler speaks for those), and whether
 * any recent reading was short. Read now, not reused: the count has to be the one after the death.
 */
export const witnessedKillCause = async (services: Pick<Services, "conversations" | "resources">, conversationId: string): Promise<KillCause> => {
    const before = services.conversations.holdings(CHILDREN).get(conversationId)?.oomKillsAtStart;
    const shortRecently = await services.resources.shortRecently();
    const snapshot = await services.resources.snapshot();
    return killCauseOf({ oomKills: snapshot.reading.oomKills, shortRecently }, before);
};

// The advice every memory kill ends on: the wall is the box's, not the child's.
const SAME_WALL = "Starting more agents now meets the same wall; have fewer run at once, and their builds and tests one at a time.";

/**
 * The ending the parent reads for a killed child: what happened, then the way back. `own` is a kill on record of a
 * process the child itself started (memory-kill.ts): then the child is the likely cause, held for a press rather than
 * sent again by itself, and the parent is told not to hand it the same work as it was. `comesBack`: the child's own
 * failure frame said the sandbox sends the turn again by itself (its memory kill held for the memory release,
 * room-holds.ts), so the parent is told to leave it be rather than to `send` it, which would run the same work a second
 * time beside the re-run.
 */
export const killNote = (cause: KillCause, failure: string, own?: MemoryKill, comesBack = false): string => {
    if (cause === "memory" && own !== undefined) {
        return (
            `Killed when the sandbox ran out of memory (${failure}), and the process killed was its own: ${own.comm} (pid ${String(own.pid)})` +
            `${own.jobId === undefined ? "" : `, background job ${own.jobId}`}. It is the likely cause, so it is not sent again by itself. Its ` +
            `session is intact, but do not \`send\` it the same work as it was: bound what grew (fewer jobs at once, a smaller build, a ` +
            `capped input), or give the task to an agent that will.`
        );
    }
    if (cause === "memory" && comesBack) {
        return (
            `Killed when the sandbox ran out of memory (${failure}). Its session is intact, and the sandbox sends this turn again by ` +
            `itself once memory has stayed free, one conversation at a time, and its report reaches you when that ends: do not ` +
            `\`send\` it the same work meanwhile. ${SAME_WALL}`
        );
    }
    return cause === "memory"
        ? `Killed when the sandbox ran out of memory (${failure}). Its session is intact: \`send\` it a message and it carries on ` +
              `from where it stopped, once there is room for it. ${SAME_WALL}`
        : `Killed from outside its turn (${failure}). Its session is intact: \`send\` it a message and it carries on from where it stopped.`;
};
