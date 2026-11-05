import { RESTART_LOSSES, withoutResumeNote } from "@intentic/sandbox-contract/events/resume";
import { MEMORY_KILL_RERUNS } from "@intentic/sandbox-contract/schemas/turn-break";
import type { ConversationActors } from "../../../../conversations/actor/conversation-actors.js";
import type { Holding } from "../../../../conversations/actor/conversation-holdings.js";
import type { HeldRecord } from "../../../../conversations/actor/conversation-state.js";
import { logsRoot } from "../../../../seams/logs-root.js";
import { readTrail } from "../../../../system/boot/restarts/memory-trail.js";
import { killSentence } from "../../../../system/resources/memory-kill-words.js";
import { MEMORY_KILLS_FILE, type MemoryKill, MemoryKillSchema } from "../../../../system/resources/memory-records.js";
import { withClause } from "../../frames/frame-clause.js";
import type { HeldTurn, MemoryKillHold } from "./held-turn.js";

/* A TURN KILLED BECAUSE THE SANDBOX RAN OUT OF MEMORY (2026-11-05). One background job grew without limit, the VM
   thrashed, netd killed the frozen daemon, and five turns came back "interrupted" in Attention although only one
   conversation had caused it. Two paths now bring the victims back by themselves and hold the cause:
   - a runtime killed under a daemon that stays up is dressed as a memory kill when its death was memory's
     (classify-failure.ts dressDeath): a kill of this conversation's own process in the records netd and the OOM
     detector write as they kill (memory-kills.jsonl), the OOM counter, or the budget's sampler seeing the box short;
   - a boot after a restart the post-mortem traced to memory holds every turn the restart cut the same way
     (turn-resume.ts recordOrRerun).
   Either way the turn is held as `stopped` with `memoryKill` on it, and goes back through the memory release
   (room-holds.ts): once memory has stayed free, one conversation at a time, on that conversation's answer to a memory
   kill. Not the stop ladder: its five seconds would send a victim back into the very shortage that killed it, and every
   victim at once. Never the conversation whose own process was the one killed, and never a request killed for memory
   again after MEMORY_KILL_RERUNS re-runs: those are held for a press, since bringing them back is bringing back the
   runaway. This module is what those paths share: reading the kills on record, counting the re-runs, and the words. */

// How far around a death a kill on record counts as its cause. netd writes its line as it kills; the runtime's exit
// reaches the daemon a moment later, or minutes later where the daemon's own loop was what memory starved.
const MEMORY_KILL_WINDOW_MS = 5 * 60_000;

// How much of the file's end is read: the last few minutes of kills are a handful of lines, and the file is never
// rotated by the daemon, so its whole length is no measure of what is wanted.
const TAIL_BYTES = 256 * 1024;

/**
 * Every process killed for memory in the `windowMs` before `now` (and a moment after, for a clock read just before the
 * line landed), as netd recorded it under `<history>/logs`. Nothing on file reads as nothing killed; a file that is there
 * and cannot be read throws, for the caller to say. Read through the boot's own reader (memory-trail.ts), synchronously:
 * it is a bounded tail, read once on a runtime's death.
 */
export const recentMemoryKills = async (historyRoot: string, now: number, windowMs: number = MEMORY_KILL_WINDOW_MS): Promise<readonly MemoryKill[]> => {
    const trail = readTrail(logsRoot(historyRoot), MEMORY_KILLS_FILE, MemoryKillSchema, TAIL_BYTES);
    if (trail.unreadable !== undefined) {
        throw new Error(`the memory kills on record could not be read: ${trail.unreadable}`);
    }
    return trail.rows.filter((kill) => kill.at >= now - windowMs && kill.at <= now + 60_000);
};

/**
 * The kill on record whose process this conversation started: netd and the OOM detector read the owner stamp off the
 * process's environment (seams/workload-stamp.ts), which a turn's runtime is spawned with and everything it starts
 * inherits, so this is a kill of the runtime itself or of anything under it.
 */
export const ownKillOf = (kills: readonly MemoryKill[], conversationId: string): MemoryKill | undefined => kills.findLast((kill) => kill.owner === conversationId);

/** The kill that best names what happened: the largest process killed, by what it held. */
export const largestKill = (kills: readonly MemoryKill[]): MemoryKill | undefined =>
    kills.reduce<MemoryKill | undefined>((largest, kill) => (largest === undefined || heldBytes(kill) > heldBytes(largest) ? kill : largest), undefined);

const heldBytes = (kill: MemoryKill): number => (kill.rssBytes ?? 0) + (kill.swapBytes ?? 0);

/* HOW MANY TIMES ONE REQUEST HAS COME BACK AFTER A MEMORY KILL. Kept beside the conversation rather than on its hold,
   which every turn start wipes: the count has to outlive the very re-run it bounds, as the stop ladder's does
   (conversation-state.ts stopTries). Keyed by the request (its message id, else its words with any resume note taken
   off), so a person's next message starts again from none, and the re-run of the same one counts on. The hold carries the
   count too (MemoryKillHold.reruns), which is what survives a restart. */

interface MemoryReruns {
    readonly request: string;
    readonly made: number;
}

const MEMORY_RERUNS: Holding<MemoryReruns> = { name: "memory-reruns" };

type Actors = Pick<ConversationActors, "holdings">;

const requestOf = (input: { readonly prompt: string; readonly messageId?: string | undefined }): string => input.messageId ?? withoutResumeNote(input.prompt);

/** How many times the memory release has already sent this request again, in this conversation. */
export const memoryRerunsMade = (actors: Actors, conversationId: string, input: { readonly prompt: string; readonly messageId?: string | undefined }): number => {
    const made = actors.holdings(MEMORY_RERUNS).get(conversationId);
    return made !== undefined && made.request === requestOf(input) ? made.made : 0;
};

/** Counts the re-run the memory release is about to send for this hold, before it goes. */
export const noteMemoryRerun = (actors: Actors, conversationId: string, held: HeldTurn): void => {
    const made = Math.max(held.memoryKill?.reruns ?? 0, memoryRerunsMade(actors, conversationId, held.input)) + 1;
    actors.holdings(MEMORY_RERUNS).hold(conversationId, conversationId, { request: requestOf(held.input), made });
};

/**
 * The count a memory kill's re-run carries on its turn (TurnInput.memoryReruns), undefined for any other hold's: the
 * hold's own, or the release's where it just counted this one (noteMemoryRerun). The holding above lives as long as the
 * daemon and the hold only until its re-run starts, so a restart that cuts the re-run would otherwise forget every one
 * before it: the turn journal keeps the turn, and with it this count, which the boot's hold of the cut turn reads
 * (recovery/memory-restart.ts). A person's press is not the release, and adds nothing.
 */
export const memoryRerunsOf = (actors: Actors, held: HeldTurn): number | undefined =>
    held.memoryKill === undefined ? undefined : Math.max(held.memoryKill.reruns, memoryRerunsMade(actors, held.input.conversationId, held.input));

/** Whether this hold waits for the memory release: a memory kill not held for a press, not yet sent. */
export const waitsForRoom = (held: HeldRecord): boolean => held.reason === "stopped" && held.memoryKill !== undefined && held.pressOnly !== true && !held.fired;

/* THE WORDS. */

// "twice", the number MEMORY_KILL_RERUNS says, so the notice and the cap cannot drift.
const timesWord = (count: number): string => {
    switch (count) {
        case 1:
            return "once";
        case 2:
            return "twice";
        default:
            return `${String(count)} times`;
    }
};

/** What a held memory kill's notice adds where it comes back by itself once there is room. */
export const GOES_WHEN_ROOM =
    "It was killed because the sandbox ran out of memory, and is sent again by itself once memory has stayed free, one conversation at a time.";

/** The same, where the conversation's answer to a memory kill is to wait. */
export const WAITS_FOR_PRESS = "It was killed because the sandbox ran out of memory. Continue sends it again; it does not go by itself.";

/** What a memory kill whose own process was the one killed says: the kill, and why nothing sends it again. */
export const ownKillWords = (kill: MemoryKill): string =>
    `It was killed because the sandbox ran out of memory, and the process killed was this conversation's own. ${killSentence(kill)}. ` +
    "It is not sent again by itself: change what grew without limit before pressing Continue.";

/** What a request memory killed again after its re-runs says. */
export const KILLED_AGAIN =
    `This turn was killed for memory ${timesWord(MEMORY_KILL_RERUNS)} after being sent again; it is probably the cause, so it is not sent again by itself. ` +
    "Change what grew without limit before pressing Continue.";

/**
 * What a memory kill's re-run alone can tell the model, after the note every reader recognises (events/resume.ts
 * RESUME_NOTES.memory): what the sandbox found, the subagent of its own that was the cause, and what a restart costs where
 * the daemon went down with it. Undefined when there is nothing past the note.
 */
export const memoryTail = (kill: MemoryKillHold): string | undefined => {
    const parts = [
        kill.found === undefined ? undefined : `What the sandbox found: ${kill.found}`,
        kill.culpritChild === undefined
            ? undefined
            : `Your subagent ${kill.culpritChild} was the cause: its own process was the one killed for memory, so it is held until someone presses Continue on it. ` +
              "Do not send it the same work as it was: bound what grew (fewer jobs at once, a smaller build, a capped input), or give the task to an agent that will.",
        kill.restart === true ? RESTART_LOSSES : undefined,
    ].filter((part): part is string => part !== undefined);
    // What was found is the kill's sentence or the post-mortem's, neither of which ends on a stop of its own.
    return parts.length === 0 ? undefined : parts.reduce((said, part) => withClause(said, part));
};
