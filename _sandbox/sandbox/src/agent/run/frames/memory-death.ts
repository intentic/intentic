import { breakArmed, MEMORY_KILL_RERUNS } from "@intentic/sandbox-contract/schemas/turn-break";
import { opt } from "../../../opt.js";
import type { RoutedTurn } from "../../../seams/turn-starter.js";
import { killSentence } from "../../../system/resources/memory-kill-words.js";
import type { MemoryKill } from "../../../system/resources/memory-records.js";
import { type KillCause, runtimeKilled } from "../../subagents/child-death.js";
import type { HeldOf } from "../turn/holds/held-turn.js";
import { GOES_WHEN_ROOM, KILLED_AGAIN, largestKill, ownKillWords, WAITS_FOR_PRESS } from "../turn/holds/memory-kill.js";
import type { ErrorFrame, FailurePlan, FailureQueries } from "./classify-failure.js";
import { withClause } from "./frame-clause.js";

/* A RUNTIME MEMORY KILLED, under a daemon that stayed up (turn/holds/memory-kill.ts). A death no code names whose
   sentence is a kill (child-death.ts runtimeKilled) is asked about here before the stop ladder takes it: memory killed it
   where a kill on record around the death was of this conversation's own process, the OOM counter moved during a
   child's turn, or the budget's sampler saw the box short (failure-queries.ts). Then it is held as `stopped` with the
   kill on it, for the memory release rather than the ladder: it goes back once memory has stayed free, one conversation
   at a time, on the conversation's answer to a memory kill (room-holds.ts). Held for a press alone, whatever that
   answer, where the process killed was the conversation's own (the kill names it as owner) or the request has already
   come back MEMORY_KILL_RERUNS times and was killed again: either way it is likely the cause, and re-running it is
   re-running the runaway. The frame promises exactly what the release will do: "scheduled" with no instant, since room
   has none to name. */

// A killed runtime's death as the records tell it: the cause, the kills on record around it (anyone's: the largest names
// what was found), and how many times the memory release already sent this request again (memory-kill.ts).
export interface MemoryDeath {
    readonly cause: KillCause;
    readonly kills: readonly MemoryKill[];
    // A process this conversation started, killed for memory around the death: the conversation is the likely cause.
    readonly own: MemoryKill | undefined;
    readonly reruns: number;
}

// What the failure frame knew of the turn that died, and the stopped hold it would make of it.
interface Dying {
    readonly conversationId: string;
    readonly turn: RoutedTurn;
    readonly now: number;
    readonly contextTokens: number | undefined;
    readonly base: HeldOf<"stopped">;
}

type Dressed = Pick<FailurePlan, "frame" | "held">;

/** The frame and hold of a runtime memory killed; undefined for any other death, which goes on as a stop. */
export const dressedForMemory = async (event: ErrorFrame, dying: Dying, queries: FailureQueries): Promise<Dressed | undefined> => {
    if (!runtimeKilled(event.message)) {
        return undefined;
    }
    const death = await queries.memoryDeath?.(dying.conversationId, dying.turn, dying.now);
    if (death?.cause !== "memory") {
        return undefined;
    }
    // Marked as memory's, so the chat asks the memory kill's question of it rather than the stop's (turn-break.ts
    // MemoryKillMarkSchema): its answer to a stop sets a ladder this hold never climbs.
    const held = { ran: dying.base.ran, ...opt("contextTokens", dying.contextTokens), memoryKill: true };
    // How far the re-runs got, once any has gone: the reader knows what the cap is counting.
    const retries = death.reruns > 0 ? { retries: { made: death.reruns, max: MEMORY_KILL_RERUNS } } : {};
    const { own } = death;
    const named = own ?? largestKill(death.kills);
    const memoryKill = { reruns: death.reruns, ...opt("found", named === undefined ? undefined : killSentence(named)) };
    if (own !== undefined || death.reruns >= MEMORY_KILL_RERUNS) {
        const said = own === undefined ? KILLED_AGAIN : ownKillWords(own);
        const frame: ErrorFrame = { ...event, message: withClause(event.message, said), held: { ...held, pressOnly: true }, autoResume: "available", ...retries };
        return { frame, held: { ...dying.base, pressOnly: true, memoryKill } };
    }
    const armed = breakArmed(await queries.breakPolicy(dying.conversationId, "memoryKill"));
    const said = armed ? GOES_WHEN_ROOM : WAITS_FOR_PRESS;
    const frame: ErrorFrame = { ...event, message: withClause(event.message, said), held, autoResume: armed ? "scheduled" : "available", ...retries };
    return { frame, held: { ...dying.base, memoryKill } };
};
