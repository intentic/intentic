import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import { breakArmed } from "@intentic/sandbox-contract/schemas/turn-break";
import { supervisorOf } from "../../../../auth/principal.js";
import type { Services } from "../../../../composition.js";
import { opt } from "../../../../opt.js";
import { recordInterruptedTurn } from "../../../../sessions/turn-transcript.js";
import { consumeEntry, type JournalledTurn } from "../../../../store/journals/turn-journal.js";
import { breakPolicyFor } from "../break-policy.js";
import type { HeldOf } from "../holds/held-turn.js";
import { dropRunLog } from "./cut-turn-rows.js";
import { recordInterrupted } from "./interrupted-ledger.js";
import type { MemoryRestart } from "./restart-resume-policy.js";

/* A TURN A RESTART CUT, WHERE MEMORY CAUSED THE RESTART (restart-resume-policy.ts MemoryRestart). It is not re-run here,
   all at once with every other the restart cut, into a machine still recovering: it is written down as any cut turn is,
   its journal entry handed over to a hold of its own, and that hold goes back through the memory release with the turns
   memory killed under a running daemon (room-holds.ts): once memory has stayed free, one conversation at a time, on the
   conversation's answer to a memory kill. The hold is the entry's own (limit-hold.ts keeps it), so a second restart puts
   it back rather than losing the turn.
   - A conversation the post-mortem names as a culprit (its own process was the one killed) is held for a press alone,
     with what the post-mortem found on its card, and never comes back by itself.
   - Every other comes back on its answer: by itself where that is `resume` (the default), told what the post-mortem found
     and, for a parent whose subagent was the culprit, which child it was; held for a press with the same words on its
     card where the answer is `wait`. */

// What its card says, held for a press: what the post-mortem found, then why nothing sends it again.
const culpritWords = (summary: string): string =>
    `${summary} This conversation's own process was the one killed, so it is not sent again by itself: change what grew without limit before pressing Continue.`;
const waitWords = (summary: string): string =>
    `${summary} The sandbox restarted, which stopped this turn; a turn killed for memory waits for a press here, so Continue sends it again.`;

// What became of the turn, in its ledger row and its log line.
const HOW = {
    culprit: {
        fate: "held for a press: its own process was the one killed for memory",
        line: "interrupted turn held for a press: the restart ran out of memory, and this conversation's own process was the one killed",
    },
    release: {
        fate: "held for the memory release",
        line: "interrupted turn held for the memory release: the restart ran out of memory, so it goes back once memory has stayed free, one conversation at a time",
    },
    wait: {
        fate: "held for a press: memoryKillPolicy is wait",
        line: "interrupted turn held for a press: the restart ran out of memory, and this conversation's answer to a memory kill is to wait",
    },
} as const;

/** The subagent of this conversation's that the restart's post-mortem names as a culprit, to tell its parent. */
const culpritChildOf = (services: Pick<Services, "agents">, conversationId: string, memory: MemoryRestart): string | undefined =>
    [...memory.culprits].find((culprit) => culprit !== conversationId && supervisorOf(services.agents.entry(culprit)?.identity ?? {}) === conversationId);

/**
 * Holds one turn a memory restart cut, as above. Its words go on the record first, as a re-run's do; a record that still
 * refuses keeps the journal entry for the next boot, as it always has.
 */
export const holdCutForMemory = async (
    services: Services,
    entry: JournalledTurn,
    memory: MemoryRestart,
    recordedAs: { readonly drawn: readonly TranscriptRow[] | undefined; readonly run: string | undefined },
    now: number,
): Promise<void> => {
    const { conversationId } = entry.turn;
    const culprit = memory.culprits.has(conversationId);
    const armed = !culprit && breakArmed(await breakPolicyFor(services, conversationId, "memoryKill"));
    const sessionId = entry.sessionId ?? entry.turn.sessionId;
    // A turn coming back writes no closing notice: its re-run's own notice stands where its words would be shown again.
    if (!(await recordInterruptedTurn(services, entry.turn, sessionId, entry.startedAt, { resuming: armed, ...recordedAs }))) {
        services.logger.warn({ conversationId }, "interrupted turn transcript could not be written before it was held for memory; journal entry was retained");
        return;
    }
    await dropRunLog(services, entry);
    await consumeEntry(services, entry);
    const culpritChild = culpritChildOf(services, conversationId, memory);
    const held: HeldOf<"stopped"> = {
        input: entry.turn,
        reason: "stopped",
        ...opt("sessionId", sessionId),
        // A session the provider minted is one it answered in; without one there is nothing of the turn's to carry on.
        ran: sessionId !== undefined,
        ...opt("pressOnly", culprit ? true : undefined),
        // A cut memory re-run is one the release already sent once.
        memoryKill: { reruns: entry.turn.resume === "memory" ? 1 : 0, found: memory.summary, restart: true, ...opt("culpritChild", culpritChild) },
    };
    services.conversations.send(conversationId, { kind: "turn-held", held }, now);
    // Read as a turn on its way back, as a stop the ladder was bringing back is after a restart (limit-hold.ts comingBack);
    // one nothing sends by itself says why on its card instead, and waits in Attention for the press.
    services.conversations.send(conversationId, { kind: "resume-promised" }, now);
    if (!armed) {
        await services.conversations.send(conversationId, { kind: "resume-abandoned", reason: culprit ? culpritWords(memory.summary) : waitWords(memory.summary) }, now)
            .settled;
    }
    const how = HOW[culprit ? "culprit" : armed ? "release" : "wait"];
    recordInterrupted(services, entry, how.fate, now);
    services.logger.info({ conversationId, culprit, armed, ...opt("culpritChild", culpritChild), sessionId, summary: memory.summary }, how.line);
};
