import type { StreamSink } from "@intentic/contract-serve";
import { type AgentEvent, type AttachFrame, isTurnFact } from "@intentic/sandbox-contract/events/agent-events";
import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import type { AgentReply } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { RunRowIds } from "@intentic/sandbox-contract/ids/run-row-ids";
import { TranscriptFold, type TurnEnding } from "@intentic/sandbox-contract/transcript-fold";

// ONE TURN AS THE CHAT WATCHES IT (`/agent/attach`): its rows folded live by the function the sandbox daemon folds with
// (the contract's TranscriptFold), so a turn on this computer is drawn row for row as one in a sandbox is. Any number of
// windows join mid-turn: each gets the rows as they stand, the turn's facts again, then every change as it lands. A
// card the turn is parked on (a permission, a question) waits here for its reply.
//
// Every row leaves stamped with the run that made it and an id of its own (the contract's RunRowIds, the daemon's own
// stamp): a window that already holds a run's rows, from the record or an earlier attach, finds them by that stamp and
// redraws them in place. Without it a finished turn opened from the list was drawn twice (2026-11-24).

type Entry = Extract<AttachFrame, { kind: `patch` | `fact` }>;

export interface Run {
    readonly id: string;
    readonly conversationId: string;
    readonly startedAt: number;
    readonly ended: () => boolean;
    // The turn's rows as they stand, the user's opening words first.
    readonly rows: () => readonly TranscriptRow[];
    readonly publish: (event: AgentEvent) => void;
    // Parks the turn on a card until its reply; resolves undefined when the turn ends first.
    readonly park: (requestId: string) => Promise<AgentReply | undefined>;
    // Answers a parked card; false when nothing waits under that id.
    readonly resolve: (reply: AgentReply) => boolean;
    readonly parked: () => readonly string[];
    readonly finish: (ending: TurnEnding) => void;
    readonly attach: (sink: StreamSink<AttachFrame>) => void;
}

export const createRun = (id: string, conversationId: string, opening: readonly TranscriptRow[], now: () => number = Date.now): Run => {
    const startedAt = now();
    const fold = new TranscriptFold(opening, now);
    const rowIds = new RunRowIds(opening);
    const stamped = (): TranscriptRow[] =>
        fold.rows.map((row, index) => {
            const rowId = rowIds.at(index);
            return rowId === undefined ? { ...row, run: id } : { ...row, run: id, rowId };
        });
    // Facts are replayed to every attach, so a window joining late still learns the model, the mode and the spend.
    const facts: Entry[] = [];
    const sinks = new Set<StreamSink<AttachFrame>>();
    const waiting = new Map<string, (reply: AgentReply | undefined) => void>();
    let seq = 0;
    let ended = false;

    const deliver = (entry: Entry): void => {
        for (const sink of sinks) {
            if (sink.closed) {
                sinks.delete(sink);
            } else {
                sink.emit(entry);
            }
        }
    };

    return {
        id,
        conversationId,
        startedAt,
        ended: () => ended,
        rows: stamped,
        publish: (event) => {
            if (ended) {
                return;
            }
            for (const patch of fold.apply(event)) {
                seq += 1;
                deliver({ kind: `patch`, seq, patch: rowIds.stamp(patch, id) });
            }
            if (isTurnFact(event)) {
                seq += 1;
                const entry: Entry = { kind: `fact`, seq, fact: event };
                facts.push(entry);
                deliver(entry);
            }
        },
        park: (requestId) =>
            new Promise((resolve) => {
                if (ended) {
                    resolve(undefined);
                    return;
                }
                waiting.set(requestId, resolve);
            }),
        resolve: (reply) => {
            const waiter = waiting.get(reply.requestId);
            waiting.delete(reply.requestId);
            waiter?.(reply);
            return waiter !== undefined;
        },
        parked: () => [...waiting.keys()],
        finish: (ending) => {
            if (ended) {
                return;
            }
            for (const patch of fold.finish(ending)) {
                seq += 1;
                deliver({ kind: `patch`, seq, patch: rowIds.stamp(patch, id) });
            }
            ended = true;
            // A card nobody answered is let go: the turn it belonged to is over.
            for (const [requestId, waiter] of waiting) {
                waiting.delete(requestId);
                waiter(undefined);
            }
            for (const sink of sinks) {
                if (!sink.closed) {
                    sink.emit({ kind: `end` });
                    sink.close();
                }
            }
            sinks.clear();
        },
        attach: (sink) => {
            sink.emit({ kind: `attached`, run: id, startedAt, seq, rows: structuredClone(stamped()) });
            for (const fact of facts) {
                sink.emit(fact);
            }
            if (ended) {
                sink.emit({ kind: `end` });
                sink.close();
                return;
            }
            sinks.add(sink);
        },
    };
};
