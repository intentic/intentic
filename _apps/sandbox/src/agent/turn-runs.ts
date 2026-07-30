import type { AgentEvent, AgentTurn } from "@intentic/sandbox-contract";
import { recordCommands } from "./agent-commands.js";
import type { TurnJournal } from "./turn-journal.js";

/* Detached turn runs — turn EXECUTION decoupled from any client connection. POST /agent starts a run: the
 * turn generator is pumped daemon-side into a seq-stamped frame log, and any number of clients render it by
 * attaching (replay from a cursor, then live). The initiating window holds no special stream — a reload, a
 * second window, or another device attaches the same way, which is what makes a turn survive all of them.
 *
 * A finished run is retained briefly so a client that lost its stream near the end still replays the tail;
 * after that the session store is the record and attach reports NOT_FOUND. Keyed by conversationId — the
 * daemon is single-tenant behind its authenticated tunnel (same bet as agent-steering).
 *
 * The frame log is in memory, and deliberately so: the transcript's durable copy is the provider's own session
 * store, which every client replays from before it attaches. What the run writes down instead is the TURN — one
 * journal entry naming what to run again, held for exactly as long as the run is in flight (see turn-journal.ts).
 * That is what carries a turn across the death of this process, which the frame log never could. */

// The turn generator a run pumps — streamAgent's shape, injected to keep this module cycle-free of
// agent.routes (and swappable in tests).
export type TurnFn = (input: AgentTurn, signal: AbortSignal | undefined) => AsyncGenerator<AgentEvent>;

// The two moments in a turn's life where the operator might want to be told, reported to whoever started the
// run. Deliberately narrow and copy-free: this module knows WHEN a turn parks or settles, and nothing about
// how that should read on a lock screen — agent.routes owns the wording (and the decision to send at all).
// Both are fire-and-forget; an observer that throws must never affect the turn, so the pump guards them.
export interface TurnObserver {
    // The agent has stopped and is waiting for the user: a plan to approve, a question to answer, a tool
    // permission to grant. May fire several times in one turn.
    readonly awaiting: (kind: "plan" | "question" | "permission") => void;
    // The run reached its end, exactly once. `error` is set only for a genuine failure — an abort via
    // /agent/stop settles as a clean "done", because the user who pressed stop knows how it ended.
    readonly settled: (outcome: { readonly ok: boolean; readonly error?: string }) => void;
}

const RETAIN_MS = 5 * 60_000;

export class TurnRun {
    readonly id = crypto.randomUUID();
    readonly startedAt = Date.now();
    private finishedAt: number | undefined;
    private readonly frames: AgentEvent[] = [];
    private waiters: (() => void)[] = [];

    constructor(readonly prompt: string) {}

    get done(): boolean {
        return this.finishedAt !== undefined;
    }

    // True once the run is finished AND past retention — attach then reports NOT_FOUND and the map entry drops.
    expired(now: number): boolean {
        return this.finishedAt !== undefined && now - this.finishedAt > RETAIN_MS;
    }

    // The log length — a frame's seq is its 1-based position, so this is also the last stamped seq.
    get seq(): number {
        return this.frames.length;
    }

    push(event: AgentEvent): void {
        this.frames.push(event);
        this.wake();
    }

    finish(): void {
        this.finishedAt = Date.now();
        this.wake();
    }

    private wake(): void {
        const waiting = this.waiters;
        this.waiters = [];
        for (const resolve of waiting) {
            resolve();
        }
    }

    // Replay frames after `after`, then follow live until the run finishes. Any number of followers may run
    // concurrently. A follower whose consumer disconnects while parked here stays parked until the next
    // push/finish wake — bounded by the turn's end, when every follower drains and returns.
    async *follow(after: number): AsyncGenerator<{ readonly seq: number; readonly event: AgentEvent }> {
        let cursor = Math.min(after, this.frames.length);
        for (;;) {
            while (cursor < this.frames.length) {
                cursor += 1;
                yield { seq: cursor, event: this.frames[cursor - 1]! };
            }
            if (this.done) {
                return;
            }
            await new Promise<void>((resolve) => {
                this.waiters.push(resolve);
            });
        }
    }
}

const runs = new Map<string, TurnRun>();

const sweep = (): void => {
    const now = Date.now();
    for (const [conversationId, run] of runs) {
        if (run.expired(now)) {
            runs.delete(conversationId);
        }
    }
};

// Everything a run needs beyond the turn itself, all of it optional because every one of them is a side-channel
// the turn must be able to run without.
export interface RunOptions {
    readonly observer?: TurnObserver;
    // Where the in-flight turn is written down so a daemon death doesn't take it with it. Injected like TurnFn,
    // for the same reason: this module stays free of the composition (and swappable in tests).
    readonly journal?: TurnJournal;
    // How many boots have already re-run this turn — carried through so a resume that dies again is not resumed
    // a third time (see turn-resume's boot pass). A first-hand turn starts at 0.
    readonly attempts?: number;
}

// Start a detached run for the conversation's turn, or undefined when one is already live (the route 409s —
// the client serializes its own turns, so a live run means another window/device is mid-turn). The pump owns
// the generator: a thrown turn is folded into the log as an error frame (an abort — /agent/stop — as a clean
// done), so followers always see the run settle.
export function startTurnRun(
    turnFn: TurnFn,
    input: AgentTurn & { conversationId: string },
    { observer, journal, attempts = 0 }: RunOptions = {},
): TurnRun | undefined {
    sweep();
    const existing = runs.get(input.conversationId);
    if (existing !== undefined && !existing.done) {
        return undefined;
    }
    const run = new TurnRun(input.prompt);
    runs.set(input.conversationId, run);
    const provider = input.agent ?? "claude";
    /* THE JOURNAL ENTRY — opened here, updated when the session is known, closed in the pump's finally.
     *
     * Every one of those is queued behind the previous one rather than fired at the disk independently. None of
     * them may block the caller (the route acks the run id synchronously), but they must not overtake each other
     * either: a clear that raced the opening write would delete a file that does not exist yet, and one that
     * raced the session-frame update would be followed by that update RE-CREATING the entry — leaving behind, in
     * both cases, a journal entry for a turn that has already finished. Which the next boot would dutifully
     * resume. Serializing costs nothing here (at most three writes in a whole turn) and removes the entire class.
     *
     * A journal write that fails changes nothing else: the turn is the thing that matters, and the cost is one
     * turn that will not come back from a restart. */
    let journalled: Promise<unknown> = Promise.resolve();
    const journalOp = (op: (target: TurnJournal) => Promise<void>): void => {
        if (journal === undefined) {
            return;
        }
        journalled = journalled.then(() => op(journal)).catch(() => undefined);
    };
    journalOp((target) => target.recordTurn({ kind: "turn", turn: input, startedAt: run.startedAt, attempts }));
    // An observer is an optional side-channel, so it must be unable to break the turn — a throw from a
    // notification hook cannot be allowed to abort a run that is otherwise fine.
    const tell = (report: (target: TurnObserver) => void): void => {
        if (observer === undefined) {
            return;
        }
        try {
            report(observer);
        } catch {
            // Nothing to do and nowhere to report it: the turn is the thing that matters.
        }
    };
    void (async () => {
        // Set by the error frame below (or by a provider emitting one mid-stream), read once at settle.
        let failure: string | undefined;
        try {
            for await (const event of turnFn(input, undefined)) {
                // Every provider republishes its slash commands each turn; cache the latest so a conversation
                // that hasn't run one yet still has a populated `/` popover (see agent-commands.ts).
                if (event.kind === "commands") {
                    recordCommands(provider, event.items);
                }
                // The three frames that park the turn on the user. They keep the run's fetch open, so from the
                // outside it still looks "live" — which is exactly why they need their own signal.
                if (event.kind === "plan" || event.kind === "question" || event.kind === "permission") {
                    tell((target) => target.awaiting(event.kind));
                }
                // The session the provider minted or advanced for this turn, folded into the journal entry as
                // soon as it is known. It is what makes a resume CONTINUE — the partial work of the interrupted
                // turn lives in that session, and a resume without it re-runs the whole turn from nothing.
                if (event.kind === "session") {
                    const sessionId = event.sessionId;
                    journalOp((target) => target.recordTurn({ kind: "turn", turn: input, sessionId, startedAt: run.startedAt, attempts }));
                }
                if (event.kind === "error") {
                    failure = event.message;
                }
                run.push(event);
            }
        } catch (error) {
            // An abort is /agent/stop doing its job, not a failure — settle with a clean done. Detected by
            // name, not instanceof: Node's DOMException AbortError does not inherit from Error.
            const aborted = typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError";
            if (!aborted) {
                failure = error instanceof Error ? error.message : "agent turn failed";
                run.push({ kind: "error", message: failure });
            }
            run.push({ kind: "done" });
        } finally {
            run.finish();
            // This turn is no longer in flight, however it ended — a failure and an abort are both settled
            // outcomes the user has seen, and only a turn nobody got to see the end of deserves resuming.
            // Queued behind the writes above, never racing them (see the note where journalOp is defined).
            journalOp((target) => target.clearTurn(input.conversationId));
            tell((target) => target.settled(failure === undefined ? { ok: true } : { ok: false, error: failure }));
        }
    })();
    return run;
}

// The conversation's current run — live, or finished within retention. Undefined = nothing to attach to.
export function turnRunOf(conversationId: string): TurnRun | undefined {
    sweep();
    return runs.get(conversationId);
}
